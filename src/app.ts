// imports.gi
import { Point }                        from '@gi/Graphene'
import { BindConstraint, Clone }        from '@gi/Clutter'
import { BlurMode }                     from '@gi/Shell'
import { Bin }                          from '@gi/St'
import { Variant, timeout_add_seconds } from '@gi/GLib'
import { MonitorManager }               from '@gi/Meta'

// gnome-shell modules
import { Workspace }                    from '@imports/ui/workspace'
import { WorkspaceGroup }               from '@imports/ui/workspaceAnimation'
import { WindowManager }                from '@imports/ui/windowManager'
import BackgroundMenu                   from '@imports/ui/backgroundMenu'

// local modules
import constants                        from './utils/constants'
import { RoundedCornersManager }        from './manager/rounded-corners-manager'
import { BlurEffectManager }            from './manager/blur-effect-manager'
import { _log as log }                  from './utils/log'
import { AddBackgroundMenuItem }        from './utils/ui'
import { RestoreBackgroundMenu }        from './utils/ui'
import { SetupBackgroundMenu }          from './utils/ui'
import { WindowScaleFactor }            from './utils/ui'
import { ChoiceRoundedCornersCfg }      from './utils/ui'
import { connections }                  from './utils/connections'
import settings, { SchemasKeys }        from './utils/settings'
import { Padding }                      from './utils/types'
import Services                         from './dbus/services'
import BlurLoader                       from './loader/blur-loader'

// types, which will be removed in output
import { WM }                           from '@gi/Shell'
import { WindowPreview }                from '@imports/ui/windowPreview'
import { BlurEffect, global, imports }  from '@global'
import { RoundedCornersCfg }            from './utils/types'
import { Window, WindowActor }          from '@gi/Meta'
import * as Gio                         from '@gi/Gio'

// --------------------------------------------------------------- [end imports]
export class Extension {
    private _orig_add_window_clone !: (_: Window) => WindowPreview
    private _switch_ws_patch       !: () => void
    private _size_changed_patch    !: (wm: WM, actor: WindowActor) => void
    private _add_background_menu   !: typeof BackgroundMenu.addBackgroundMenu
    private _services              !: Services
    private _blur_loader           !: InstanceType<typeof BlurLoader>

    private _rounded_corners_manager = new RoundedCornersManager ()
    private _blur_effect_manager = new BlurEffectManager ()

    constructor () {
        log (constants.LOADED_MSG)
    }

    enable () {
        this._orig_add_window_clone = Workspace.prototype._addWindowClone
        this._switch_ws_patch = WorkspaceGroup.prototype._createWindows
        this._size_changed_patch = WindowManager.prototype._sizeChangeWindowDone
        this._add_background_menu = BackgroundMenu.addBackgroundMenu

        this._services = new Services ()
        this._services.export ()

        this._blur_loader = new BlurLoader ()
        this._blur_loader.connect ('loaded', () => {
            this._services.DBusImpl.emit_property_changed (
                'blur_loaded',
                Variant.new_boolean (true)
            )
            log ('Emit property changed blur_loaded to client')
            if (settings ().blur_enabled) {
                this._blur_effect_manager.enable ()
            }
        })
        this._blur_loader.enable ()

        this._enable_effect_managers ()

        connections ().connect (
            settings ().g_settings,
            'changed',
            (_: Gio.Settings, key: string) => {
                if ((key as SchemasKeys) == 'blur-enabled') {
                    if (settings ().blur_enabled) {
                        this._blur_effect_manager.enable ()
                    } else {
                        this._blur_effect_manager.disable ()
                    }
                }
            }
        )

        // Have to toggle fullscreen for all windows when changed scale factor
        // of windows because rounded-corners-manager may got incorrect frame
        // rect & buffer rect to calculate position of shadow & bound of rounded
        // corners.
        // FIXME: This is an ugly way but works. Should found a better way to
        // solve this problem.
        const monitor_manager = MonitorManager.get ()
        connections ().connect (monitor_manager, 'monitors-changed', () => {
            this._disable_effect_managers ()
            this._enable_effect_managers ()
            for (const { meta_window } of global.get_window_actors ()) {
                if (meta_window && !meta_window.is_fullscreen ()) {
                    // markup which windows has been fullscreen
                    (meta_window as Window & { __fs?: 1 }).__fs = 1
                    meta_window.make_fullscreen ()
                }
            }

            // waiting 2 seconds then unmake-fullscreen marked windows.
            timeout_add_seconds (0, 2, () => {
                for (const { meta_window } of global.get_window_actors ()) {
                    const win = meta_window as Window & { __fs?: 1 }
                    // restore them
                    if (win && win.__fs == 1) {
                        win.unmake_fullscreen ()
                        delete win.__fs
                    }
                }
                return false
            })
        })

        const self = this

        // When there is new window added into overview, this function will be
        // called. We need add our shadow actor and blur actor of rounded
        // corners window into overview.
        Workspace.prototype._addWindowClone = function (window) {
            const clone = self._orig_add_window_clone.apply (this, [window])
            const window_container = clone.window_container

            let cfg: RoundedCornersCfg | null = null
            let has_rounded_corners = false

            const shadow = self._rounded_corners_manager.query_shadow (window)
            const blur = self._blur_effect_manager.query_blur (window)

            if (shadow || blur) {
                cfg = ChoiceRoundedCornersCfg (
                    settings ().global_rounded_corner_settings,
                    settings ().custom_rounded_corner_settings,
                    window
                )
                const maximized =
                    window.maximized_horizontally ||
                    window.maximized_vertically ||
                    window.fullscreen
                has_rounded_corners = cfg.keep_rounded_corners || !maximized
            }
            if (shadow && has_rounded_corners) {
                const source = shadow
                const pivot_point = new Point ({ x: 0.5, y: 0.5 })
                const shadow_clone = new Clone ({ source, pivot_point })

                for (const prop of ['scale-x', 'scale-y']) {
                    window_container.bind_property (prop, shadow_clone, prop, 0)
                }

                for (let i = 0; i < 4; i++) {
                    shadow_clone.add_constraint (
                        new BindConstraint ({
                            coordinate: i,
                            source: window_container,
                        })
                    )
                }

                window_container.connect ('notify::width', () => {
                    const paddings =
                        (window_container.width /
                            window.get_frame_rect ().width) *
                        (constants.SHADOW_PADDING * WindowScaleFactor (window))

                    shadow_clone.get_constraints ().forEach ((_c, i) => {
                        const c = _c as BindConstraint
                        c.offset = i < 2 ? -paddings : paddings * 2
                    })
                })

                clone.insert_child_above (shadow_clone, window_container)
            }

            if (blur) {
                const blur_clone = new Bin ({
                    pivot_point: new Point ({ x: 0.5, y: 0.5 }),
                })
                const { radius, sigma } = blur.get_effects ()[0] as BlurEffect
                blur_clone.add_effect (
                    new imports.gi.Patched.BlurEffect ({
                        mode: BlurMode.BACKGROUND,
                        radius: has_rounded_corners ? radius : 0,
                        sigma,
                    })
                )

                for (const prop of ['scale-x', 'scale-y']) {
                    window_container.bind_property (prop, blur_clone, prop, 0)
                }

                for (let i = 0; i < 4; i++) {
                    blur_clone.add_constraint (
                        new BindConstraint ({
                            coordinate: i,
                            source: window_container,
                        })
                    )
                }

                const { left, right, top, bottom } =
                    has_rounded_corners && cfg ? cfg.padding : new Padding ()
                window_container.connect ('notify::width', () => {
                    const scale =
                        window_container.width / window.get_frame_rect ().width

                    const constraints = blur_clone.get_constraints () as
                        | BindConstraint[]
                        | null
                    if (constraints) {
                        constraints[0].offset = left * scale
                        constraints[1].offset = top * scale
                        constraints[2].offset = -(left + right) * scale
                        constraints[3].offset = -(top + bottom) * scale
                    }
                })

                window_container.opacity = settings ().blurred_window_opacity
                clone.insert_child_below (blur_clone, window_container)
            }

            return clone
        }

        // Just Like the monkey patch when enter overview, need to add shadow
        // actor and blur actor into WorkspaceGroup to see them when switching
        // workspace
        WorkspaceGroup.prototype._createWindows = function () {
            self._switch_ws_patch.apply (this)

            this._windowRecords.forEach (({ windowActor: actor, clone }) => {
                const win = actor.meta_window
                const frame_rect = win.get_frame_rect ()
                const cfg = ChoiceRoundedCornersCfg (
                    settings ().global_rounded_corner_settings,
                    settings ().custom_rounded_corner_settings,
                    win
                )
                const maximized =
                    win.maximized_horizontally ||
                    win.maximized_vertically ||
                    win.fullscreen
                const has_rounded_corners =
                    cfg.keep_rounded_corners || !maximized

                const shadow = self._rounded_corners_manager.query_shadow (win)
                if (shadow && has_rounded_corners) {
                    // Only create shadow actor when window should have rounded
                    // corners when switching workspace

                    // Copy shadow actor to workspace group, so that to see
                    // shadow when switching workspace
                    const shadow_clone = new Clone ({ source: shadow })
                    const paddings =
                        constants.SHADOW_PADDING * WindowScaleFactor (win)

                    shadow_clone.width = frame_rect.width + paddings * 2
                    shadow_clone.height = frame_rect.height + paddings * 2
                    shadow_clone.x = clone.x + frame_rect.x - actor.x - paddings
                    shadow_clone.y = clone.y + frame_rect.y - actor.y - paddings

                    clone.connect (
                        'notify::translation-z',
                        () =>
                            (shadow_clone.translation_z =
                                clone.translation_z + 0.006)
                    )

                    this.insert_child_above (shadow_clone, clone)
                }

                // Copy shadow actor to workspace group, so that to see shadow
                // when switching workspace
                const blur = self._blur_effect_manager.query_blur (win)
                if (blur) {
                    // Handle padding of rounded corners window
                    const { left, right, top, bottom } = has_rounded_corners
                        ? cfg.padding
                        : new Padding ()

                    const scale = WindowScaleFactor (win)
                    const blur_clone = new Bin ({
                        pivot_point: new Point ({ x: 0.5, y: 0.5 }),
                        x: clone.x + frame_rect.x - actor.x + left * scale,
                        y: clone.y + frame_rect.y - actor.y + top * scale,
                        width: frame_rect.width - (right + left) * scale,
                        height: frame_rect.height - (top + bottom) * scale,
                    })
                    const { radius, sigma } =
                        blur.get_effects ()[0] as BlurEffect
                    blur_clone.add_effect (
                        new imports.gi.Patched.BlurEffect ({
                            mode: BlurMode.BACKGROUND,
                            radius: has_rounded_corners ? radius : 0,
                            sigma,
                        })
                    )
                    clone.connect (
                        'notify::translation-z',
                        () =>
                            (blur_clone.translation_z =
                                clone.translation_z - 0.006)
                    )

                    clone.opacity = settings ().blurred_window_opacity
                    this.insert_child_below (blur_clone, clone)
                }
            })
        }

        // Window Size Changed
        WindowManager.prototype._sizeChangeWindowDone = function (
            shell_wm,
            actor
        ) {
            self._size_changed_patch.apply (this, [shell_wm, actor])
            // Update shadow actor
            self._rounded_corners_manager.on_size_changed (actor)
            self._rounded_corners_manager._on_focus_changed (actor.meta_window)
            self._blur_effect_manager.update_blur_effect (actor)
            self._blur_effect_manager.update_coordinates (actor.meta_window)
        }

        SetupBackgroundMenu ()
        BackgroundMenu.addBackgroundMenu = (actor, layout) => {
            this._add_background_menu (actor, layout)
            AddBackgroundMenuItem (actor._backgroundMenu)
        }

        log ('Enabled')
    }

    disable () {
        // Restore patched methods
        Workspace.prototype._addWindowClone = this._orig_add_window_clone
        WorkspaceGroup.prototype._createWindows = this._switch_ws_patch
        WindowManager.prototype._sizeChangeWindowDone = this._size_changed_patch
        BackgroundMenu.addBackgroundMenu = this._add_background_menu

        RestoreBackgroundMenu ()

        this._services.unexport ()
        this._disable_effect_managers ()

        connections ().disconnect_all ()

        log ('Disabled')
    }

    private _enable_effect_managers () {
        if (settings ().blur_enabled) {
            this._blur_effect_manager.enable ()
        }
        this._rounded_corners_manager.enable ()
    }

    private _disable_effect_managers () {
        this._rounded_corners_manager.disable ()
        this._blur_effect_manager.disable ()
    }
}
