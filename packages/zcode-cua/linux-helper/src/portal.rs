// xdg-desktop-portal RemoteDesktop 后端：坐标/全局输入注入。
//
// 与 a11y（AT-SPI，元素级动作，零授权）互补：本模块负责「按屏幕坐标点击 / 滚动 /
// 全局键盘 / 文本输入」——这些必须经 portal 的 RemoteDesktop 会话注入，首次需要用户
// 在 portal 弹窗里授权一次（restore_token 可持久化，后续免弹）。
//
// 线程模型：portal 会话绑定在创建它的 tokio runtime 上（zbus reactor），不能跨 runtime
// await。因此起一个专用线程持有自己的多线程 runtime，用 mpsc 命令串行驱动所有 portal
// 操作；各连接线程通过 oneshot 等待结果。这样与每连接一个 current-thread runtime 的
// 读树逻辑完全隔离，portal 不可用也不影响 a11y 功能。
//
// 当前只做 RemoteDesktop（键盘 + 指针）；抓屏（ScreenCast/PipeWire）留待后续。
// 无 screencast 时 absolute 指针用 stream=0（KDE 实现下即整屏坐标空间）。

use std::os::fd::AsRawFd;
use std::sync::OnceLock;

use ashpd::desktop::remote_desktop::{Axis, DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions};
use ashpd::desktop::screencast::{
    CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType,
};
use ashpd::desktop::PersistMode;
use tokio::sync::{mpsc, oneshot};

/// Linux evdev 指针按键码（portal NotifyPointerButton 使用 evdev code）。
pub const BTN_LEFT: i32 = 0x110;
pub const BTN_RIGHT: i32 = 0x111;
pub const BTN_MIDDLE: i32 = 0x112;

pub(crate) struct PortalSession {
    desktop: RemoteDesktop,
    session: ashpd::desktop::Session<RemoteDesktop>,
    /// ScreenCast 流的 portal id（NotifyPointerMotionAbsolute 的 stream 参数）。
    /// 没有它时 absolute motion 会被 portal 拒为 "Invalid position"。
    stream_id: Option<u32>,
    /// ScreenCast 的 PipeWire fd（用于抓帧）。保留在会话里以维持流存活。
    pipewire_fd: Option<std::os::fd::OwnedFd>,
    /// ScreenCast 流的逻辑尺寸（portal 上报的 size，单位=逻辑像素）。
    /// 抓帧 raster 尺寸 = 逻辑尺寸 × 桌面缩放比（本机 1.25），故截图坐标
    /// 需除以 (raster/logical) 才能用于注入。
    logical_size: Option<(f64, f64)>,
}

enum Cmd {
    Ensure(oneshot::Sender<Result<(), String>>),
    Click {
        x: f64,
        y: f64,
        button: i32,
        clicks: u32,
        resp: oneshot::Sender<Result<(), String>>,
    },
    /// 只移动指针（绝对坐标），不发任何 button。
    Move {
        x: f64,
        y: f64,
        resp: oneshot::Sender<Result<(), String>>,
    },
    /// 离散滚动（滚轮步进语义）：axis + steps。
    ScrollDiscrete {
        axis: Axis,
        steps: i32,
        resp: oneshot::Sender<Result<(), String>>,
    },
    /// keysym 序列：每个 (keysym, pressed)。
    Keyseq {
        events: Vec<(i32, bool)>,
        resp: oneshot::Sender<Result<(), String>>,
    },
    /// 拖拽：按下 → 分步移动 → 抬起。modifiers 为需要全程按住的 keysym。
    Drag {
        start: (f64, f64),
        end: (f64, f64),
        modifiers: Vec<i32>,
        resp: oneshot::Sender<Result<(), String>>,
    },
    /// 按下指定 keysym 并保持 duration_ms，然后释放。可被 CancelHold 打断。
    HoldKey {
        keysym: i32,
        duration_ms: u64,
        resp: oneshot::Sender<Result<(), String>>,
    },
    Status(oneshot::Sender<bool>),
    /// 查询会话的屏幕逻辑尺寸（建会话以取得）。
    ScreenInfo(oneshot::Sender<Result<(f64, f64), String>>),
    /// 抓一帧屏幕（PNG 字节）。
    Capture(oneshot::Sender<Result<Vec<u8>, String>>),
    Reset(oneshot::Sender<()>),
}

static TX: OnceLock<mpsc::UnboundedSender<Cmd>> = OnceLock::new();

/// 当前是否有 hold_key 正在进行（用于 cancel_input_holds 的跨连接查询）。
static HOLDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 取消标志：cancel_input_holds 在另一条连接上置位，hold 循环每 50ms 检查。
static HOLD_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn token_path() -> String {
    let uid = libc_getuid();
    format!("/tmp/zcode-cua-portal-{}.token", uid)
}

// 避免引入 libc 依赖，直接用 std 拿 uid 的简单实现。
fn libc_getuid() -> u32 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self")
        .map(|m| m.uid())
        .unwrap_or(0)
}

fn load_token() -> Option<String> {
    std::fs::read_to_string(token_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn save_token(token: &str) {
    let _ = std::fs::write(token_path(), token);
}

/// 启动 portal 管理线程（幂等）。返回命令发送端。
fn ensure_worker() -> &'static mpsc::UnboundedSender<Cmd> {
    TX.get_or_init(|| {
        let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(1)
                .build()
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[portal] runtime build failed: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let mut state: Option<PortalSession> = None;
                while let Some(cmd) = rx.recv().await {
                    handle(cmd, &mut state).await;
                }
            });
        });
        tx
    })
}

async fn build_session() -> Result<PortalSession, String> {
    // 先注册 host 应用身份：非沙箱程序必须向 portal 声明自己的 app_id，否则授权无法
    // 归属到具体应用（也无法用 restore_token 持久化）。
    eprintln!("[portal] build_session: register_host_app({APP_ID})");
    register_app_identity().await?;
    eprintln!("[portal] build_session: RemoteDesktop::new");
    let desktop = RemoteDesktop::new().await.map_err(|e| format!("RemoteDesktop::new: {e}"))?;
    eprintln!("[portal] build_session: create_session");
    let session = desktop
        .create_session(Default::default())
        .await
        .map_err(|e| format!("create_session: {e}"))?;
    let restore = load_token();
    eprintln!("[portal] build_session: select_devices (restore_token={})", restore.is_some());
    let mut opts = SelectDevicesOptions::default()
        .set_devices(DeviceType::Keyboard | DeviceType::Pointer)
        .set_persist_mode(PersistMode::ExplicitlyRevoked);
    if let Some(tok) = restore.as_deref() {
        opts = opts.set_restore_token(tok);
    }
    desktop
        .select_devices(&session, opts)
        .await
        .map_err(|e| format!("select_devices: {e}"))?
        .response()
        .map_err(|e| format!("select_devices response: {e}"))?;
    // ScreenCast：与 RemoteDesktop 同一 session。绝对坐标注入必须引用一个 ScreenCast 流，
    // 否则 portal 拒为 "Invalid position"。这里选整个显示器（Monitor）。
    eprintln!("[portal] build_session: select_sources (Monitor)");
    // 与 RemoteDesktop 复用同一 D-Bus 连接：KDE 的 portal-kde 实现里，RemoteDesktop 会话
    // 内建的 ScreenCast 流状态挂在该连接上；用独立连接（ashpd 示例的写法，适用于 GNOME）
    // 会让 KDE 侧不返回 streams。
    let screencast = Screencast::with_connection(desktop.connection().clone())
        .await
        .map_err(|e| format!("Screencast::with_connection: {e}"))?;
    screencast
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_sources(Some(SourceType::Monitor.into()))
                .set_cursor_mode(CursorMode::Embedded)
                .set_multiple(false),
        )
        .await
        .map_err(|e| format!("select_sources: {e}"))?
        .response()
        .map_err(|e| format!("select_sources response: {e}"))?;
    eprintln!("[portal] build_session: start (会弹系统授权窗，等待用户确认)");
    let selected = desktop
        .start(&session, None, Default::default())
        .await
        .map_err(|e| format!("start: {e}"))?
        .response()
        .map_err(|e| format!("start response: {e}"))?;
    eprintln!("[portal] build_session: ok, devices={:?}", selected.devices());
    // KDE 的 portal-kde 用 PipeWire node id 作为 absolute motion 的 stream 参数
    // （portal stream id 在 KDE 实现里是 None）。优先取 pipe_wire_node_id。
    let stream_id = selected.streams().first().map(|s| {
        s.id()
            .and_then(|id| id.parse::<u32>().ok())
            .unwrap_or_else(|| s.pipe_wire_node_id())
    });
    eprintln!("[portal] build_session: streams={:?}", selected.streams());
    eprintln!("[portal] build_session: stream_id={:?}", stream_id);
    let logical_size = selected
        .streams()
        .first()
        .and_then(|s| s.size())
        .map(|(w, h)| (w as f64, h as f64));
    if let Some(t) = selected.restore_token() {
        save_token(t);
    }
    // 抓帧用的 PipeWire fd（ScreenCast 的 OpenPipeWireRemote）。
    let pipewire_fd = match screencast
        .open_pipe_wire_remote(&session, OpenPipeWireRemoteOptions::default())
        .await
    {
        Ok(fd) => {
            eprintln!("[portal] build_session: pipewire fd acquired");
            Some(fd)
        }
        Err(e) => {
            eprintln!("[portal] build_session: open_pipe_wire_remote failed: {e}");
            None
        }
    };
    Ok(PortalSession {
        desktop,
        session,
        stream_id,
        pipewire_fd,
        logical_size,
    })
}

/// 确保有可用会话：没有则建一个。
///
/// 用户授权过一次后，portal 凭 app_id 记住授权（KDE 实测：注册 app_id 后再次请求不再
/// 弹窗），所以这里自动建会话不会打扰用户；从未授权时 build_session 会因用户未确认而
/// 失败，调用方据此返回 needs_grant。
async fn ensure(state: &mut Option<PortalSession>) -> Result<(), String> {
    if state.is_some() {
        return Ok(());
    }
    let s = build_session().await?;
    *state = Some(s);
    Ok(())
}

async fn handle(cmd: Cmd, state: &mut Option<PortalSession>) {
    match cmd {
        Cmd::Ensure(resp) => {
            if state.is_some() {
                let _ = resp.send(Ok(()));
                return;
            }
            match build_session().await {
                Ok(s) => {
                    *state = Some(s);
                    let _ = resp.send(Ok(()));
                }
                Err(e) => {
                    let _ = resp.send(Err(e));
                }
            }
        }
        Cmd::Status(resp) => {
            let _ = resp.send(state.is_some());
        }
        Cmd::ScreenInfo(resp) => {
            if let Err(e) = ensure(state).await {
                let _ = resp.send(Err(format!("needs_grant: {e}")));
                return;
            }
            let r = state
                .as_ref()
                .and_then(|s| s.logical_size)
                .ok_or_else(|| "no screencast stream size".to_string());
            let _ = resp.send(r);
        }
        Cmd::Capture(resp) => {
            if let Err(e) = ensure(state).await {
                let _ = resp.send(Err(format!("needs_grant: {e}")));
                return;
            }
            let r = capture_frame(state);
            let _ = resp.send(r);
        }
        Cmd::Reset(resp) => {
            *state = None;
            let _ = std::fs::remove_file(token_path());
            let _ = resp.send(());
        }
        Cmd::Click {
            x,
            y,
            button,
            clicks,
            resp,
        } => {
            if let Err(e) = ensure(state).await {
                let _ = resp.send(Err(format!("needs_grant: {e}")));
                return;
            }
            let s = match state.as_mut() {
                Some(s) => s,
                None => {
                    let _ = resp.send(Err("needs_grant".into()));
                    return;
                }
            };
            let r = async {
                let stream = s.stream_id.ok_or_else(|| {
                    "no ScreenCast stream id; absolute pointer motion unavailable".to_string()
                })?;
                s.desktop
                    .notify_pointer_motion_absolute(&s.session, stream, x, y, Default::default())
                    .await
                    .map_err(|e| format!("motion_absolute: {e}"))?;
                for _ in 0..clicks.max(1) {
                    s.desktop
                        .notify_pointer_button(&s.session, button, KeyState::Pressed, Default::default())
                        .await
                        .map_err(|e| format!("button down: {e}"))?;
                    s.desktop
                        .notify_pointer_button(&s.session, button, KeyState::Released, Default::default())
                        .await
                        .map_err(|e| format!("button up: {e}"))?;
                }
                Ok::<(), String>(())
            }
            .await;
            let _ = resp.send(r);
        }
        Cmd::Move { x, y, resp } => {
            if let Err(e) = ensure(state).await {
                let _ = resp.send(Err(format!("needs_grant: {e}")));
                return;
            }
            let s = state.as_ref().unwrap();
            let r = match s.stream_id {
                Some(stream) => s
                    .desktop
                    .notify_pointer_motion_absolute(&s.session, stream, x, y, Default::default())
                    .await
                    .map_err(|e| format!("motion_absolute: {e}")),
                None => Err("no ScreenCast stream id".to_string()),
            };
            let _ = resp.send(r);
        }
        Cmd::ScrollDiscrete {
            axis,
            steps,
            resp,
        } => {
            let s = match state.as_mut() {
                Some(s) => s,
                None => {
                    let _ = resp.send(Err("needs_grant".into()));
                    return;
                }
            };
            let r = s
                .desktop
                .notify_pointer_axis_discrete(&s.session, axis, steps, Default::default())
                .await
                .map_err(|e| format!("axis_discrete: {e}"));
            let _ = resp.send(r);
        }
        Cmd::Drag {
            start,
            end,
            modifiers,
            resp,
        } => {
            if let Err(e) = ensure(state).await {
                let _ = resp.send(Err(format!("needs_grant: {e}")));
                return;
            }
            let s = match state.as_mut() {
                Some(s) => s,
                None => {
                    let _ = resp.send(Err("needs_grant".into()));
                    return;
                }
            };
            let r = async {
                let stream = s.stream_id.ok_or_else(|| {
                    "no ScreenCast stream id; absolute pointer motion unavailable".to_string()
                })?;
                // 修饰键按下（全程保持）
                for ks in &modifiers {
                    s.desktop
                        .notify_keyboard_keysym(&s.session, *ks, KeyState::Pressed, Default::default())
                        .await
                        .map_err(|e| format!("modifier down {ks}: {e}"))?;
                }
                // 移到起点 → 按下左键
                s.desktop
                    .notify_pointer_motion_absolute(&s.session, stream, start.0, start.1, Default::default())
                    .await
                    .map_err(|e| format!("drag move start: {e}"))?;
                s.desktop
                    .notify_pointer_button(&s.session, BTN_LEFT, KeyState::Pressed, Default::default())
                    .await
                    .map_err(|e| format!("drag button down: {e}"))?;
                // 分步移动：真实拖拽需要中间 motion，直接跳到终点很多应用不认。
                const STEPS: u32 = 12;
                for i in 1..=STEPS {
                    let t = i as f64 / STEPS as f64;
                    let x = start.0 + (end.0 - start.0) * t;
                    let y = start.1 + (end.1 - start.1) * t;
                    s.desktop
                        .notify_pointer_motion_absolute(&s.session, stream, x, y, Default::default())
                        .await
                        .map_err(|e| format!("drag move step {i}: {e}"))?;
                    tokio::time::sleep(std::time::Duration::from_millis(16)).await;
                }
                s.desktop
                    .notify_pointer_button(&s.session, BTN_LEFT, KeyState::Released, Default::default())
                    .await
                    .map_err(|e| format!("drag button up: {e}"))?;
                // 释放修饰键（倒序）
                for ks in modifiers.iter().rev() {
                    s.desktop
                        .notify_keyboard_keysym(&s.session, *ks, KeyState::Released, Default::default())
                        .await
                        .map_err(|e| format!("modifier up {ks}: {e}"))?;
                }
                Ok::<(), String>(())
            }
            .await;
            let _ = resp.send(r);
        }
        Cmd::HoldKey {
            keysym,
            duration_ms,
            resp,
        } => {
            if let Err(e) = ensure(state).await {
                let _ = resp.send(Err(format!("needs_grant: {e}")));
                return;
            }
            let s = match state.as_mut() {
                Some(s) => s,
                None => {
                    let _ = resp.send(Err("needs_grant".into()));
                    return;
                }
            };
            let r = async {
                s.desktop
                    .notify_keyboard_keysym(&s.session, keysym, KeyState::Pressed, Default::default())
                    .await
                    .map_err(|e| format!("hold down {keysym}: {e}"))?;
                HOLDING.store(true, std::sync::atomic::Ordering::SeqCst);
                // 分片等待，每 50ms 检查取消标志（cancel_input_holds 跨连接写入）。
                let mut left = duration_ms;
                let mut cancelled = false;
                while left > 0 {
                    if HOLD_CANCEL.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        cancelled = true;
                        break;
                    }
                    let step = left.min(50);
                    tokio::time::sleep(std::time::Duration::from_millis(step)).await;
                    left -= step;
                }
                HOLDING.store(false, std::sync::atomic::Ordering::SeqCst);
                s.desktop
                    .notify_keyboard_keysym(&s.session, keysym, KeyState::Released, Default::default())
                    .await
                    .map_err(|e| format!("hold up {keysym}: {e}"))?;
                if cancelled {
                    Err("cancelled".to_string())
                } else {
                    Ok(())
                }
            }
            .await;
            let _ = resp.send(r);
        }
        Cmd::Keyseq { events, resp } => {
            if let Err(e) = ensure(state).await {
                let _ = resp.send(Err(format!("needs_grant: {e}")));
                return;
            }
            let s = match state.as_mut() {
                Some(s) => s,
                None => {
                    let _ = resp.send(Err("needs_grant".into()));
                    return;
                }
            };
            let r = async {
                for (keysym, pressed) in events {
                    let ks = if pressed { KeyState::Pressed } else { KeyState::Released };
                    s.desktop
                        .notify_keyboard_keysym(&s.session, keysym, ks, Default::default())
                        .await
                        .map_err(|e| format!("keysym {keysym}: {e}"))?;
                }
                Ok::<(), String>(())
            }
            .await;
            let _ = resp.send(r);
        }
    }
}

async fn send_cmd<T>(make: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T, String> {
    let tx = ensure_worker();
    let (otx, orx) = oneshot::channel();
    tx.send(make(otx)).map_err(|_| "portal worker gone".to_string())?;
    orx.await.map_err(|_| "portal worker dropped".to_string())
}

/// 确保 portal 会话已建立（首次会触发一次授权弹窗；之后靠 restore_token 免弹）。
pub async fn ensure_session() -> Result<(), String> {
    send_cmd(|otx| Cmd::Ensure(otx)).await?
}

/// 当前是否已有活会话（即用户已授权过）。
pub async fn has_session() -> bool {
    send_cmd(|otx| Cmd::Status(otx)).await.unwrap_or(false)
}

/// 撤销授权并清掉 restore_token。
pub async fn reset_session() {
    let _ = send_cmd(|otx| Cmd::Reset(otx)).await;
}

pub async fn click(x: f64, y: f64, button: i32, clicks: u32) -> Result<(), String> {
    send_cmd(|resp| Cmd::Click {
        x,
        y,
        button,
        clicks,
        resp,
    })
    .await?
}

/// 只移动指针到绝对坐标（逻辑坐标空间）。
pub async fn move_pointer(x: f64, y: f64) -> Result<(), String> {
    send_cmd(|resp| Cmd::Move { x, y, resp }).await?
}

/// 离散滚动（滚轮步进）。axis: 0=Horizontal 1=Vertical（portal Axis 枚举）。
pub async fn scroll_discrete(axis_is_horizontal: bool, steps: i32) -> Result<(), String> {
    let axis = if axis_is_horizontal {
        Axis::Horizontal
    } else {
        Axis::Vertical
    };
    send_cmd(|resp| Cmd::ScrollDiscrete {
        axis,
        steps,
        resp,
    })
    .await?
}

pub async fn key_events(events: Vec<(i32, bool)>) -> Result<(), String> {
    send_cmd(|resp| Cmd::Keyseq { events, resp }).await?
}

/// 拖拽：start→end，modifiers 为全程按住的 keysym 列表。
pub async fn drag(
    start: (f64, f64),
    end: (f64, f64),
    modifiers: Vec<i32>,
) -> Result<(), String> {
    send_cmd(|resp| Cmd::Drag {
        start,
        end,
        modifiers,
        resp,
    })
    .await?
}

/// 按住单个 keysym duration_ms 后释放；可被 `cancel_hold()` 打断。
pub async fn hold_key(keysym: i32, duration_ms: u64) -> Result<(), String> {
    send_cmd(|resp| Cmd::HoldKey {
        keysym,
        duration_ms,
        resp,
    })
    .await?
}

/// 取消进行中的 hold（由另一条 broker 连接调用 `cancel_input_holds`）。
/// 返回是否真有 hold 在进行。
pub fn cancel_hold() -> bool {
    if HOLDING.load(std::sync::atomic::Ordering::SeqCst) {
        HOLD_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
        true
    } else {
        false
    }
}

/// 抓一帧屏幕（PNG 字节）。
pub async fn capture_png() -> Result<Vec<u8>, String> {
    send_cmd(|resp| Cmd::Capture(resp)).await?
}

/// 屏幕逻辑尺寸（逻辑像素）。抓帧 raster 尺寸除以它 = 缩放比。
pub async fn screen_logical_size() -> Result<(f64, f64), String> {
    send_cmd(|resp| Cmd::ScreenInfo(resp)).await?
}

/// 把普通文本转成 keysym 事件序列（仅支持可映射到 keysym 的字符，ASCII 为主）。
pub fn text_to_key_events(text: &str) -> Vec<(i32, bool)> {
    let mut ev = Vec::new();
    for ch in text.chars() {
        if let Some(ks) = char_to_keysym(ch) {
            ev.push((ks, true));
            ev.push((ks, false));
        }
    }
    ev
}

/// 单字符 → X keysym。ASCII 可打印字符的 keysym 等于其码点；常见控制字符单列。
pub fn char_to_keysym(ch: char) -> Option<i32> {
    match ch {
        '\n' | '\r' => Some(0xFF0D), // Return
        '\t' => Some(0xFF09),
        '\u{1b}' => Some(0xFF1B),
        ' '..='~' => Some(ch as i32),
        _ => None, // 非 ASCII（中文等）需输入法，暂不支持
    }
}

/// 命名键 → keysym（供 key(text="return"/"escape"/... ) 与组合键使用）。
pub fn named_key_keysym(name: &str) -> Option<i32> {
    let n = name.trim().to_lowercase();
    Some(match n.as_str() {
        "return" | "enter" => 0xFF0D,
        "tab" => 0xFF09,
        "escape" | "esc" => 0xFF1B,
        "space" => 0x0020,
        "backspace" => 0xFF08,
        "delete" | "del" => 0xFFFF,
        "up" => 0xFF52,
        "down" => 0xFF54,
        "left" => 0xFF51,
        "right" => 0xFF53,
        "home" => 0xFF50,
        "end" => 0xFF57,
        "pageup" => 0xFF55,
        "pagedown" => 0xFF56,
        "f1" => 0xFFBE,
        "f2" => 0xFFBF,
        "f3" => 0xFFC0,
        "f4" => 0xFFC1,
        "f5" => 0xFFC2,
        "f6" => 0xFFC3,
        "f7" => 0xFFC4,
        "f8" => 0xFFC5,
        "f9" => 0xFFC6,
        "f10" => 0xFFC7,
        "f11" => 0xFFC8,
        "f12" => 0xFFC9,
        _ => {
            // 单字符回退
            let mut it = n.chars();
            let c = it.next()?;
            if it.next().is_none() {
                return char_to_keysym(c);
            }
            return None;
        }
    })
}

/// 修饰键 keysym。
pub fn modifier_keysym(name: &str) -> Option<i32> {
    Some(match name.trim().to_lowercase().as_str() {
        "ctrl" | "control" => 0xFFE3, // Control_L
        "shift" => 0xFFE1,            // Shift_L
        "alt" => 0xFFE9,              // Alt_L
        "super" | "meta" | "win" | "cmd" => 0xFFEB, // Super_L
        _ => return None,
    })
}

/// portal 用的应用 ID。portal 靠它记录授权归属（非沙箱程序必须显式注册）。
/// 命名遵循 portal 规范：至少含一个点、长度 ≤ 255。
pub const APP_ID: &str = "com.zcode.cua-linux-helper";

/// .desktop 文件路径（portal 校验 app_id 时会检查它存在）。
fn desktop_file_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    format!("{home}/.local/share/applications/{APP_ID}.desktop")
}

/// 幂等写入 .desktop（缺失才写）。portal 的 Register 要求 app_id 对应的 desktop 文件存在，
/// 否则注册会失败或授权对话框无法显示应用名/图标。
fn ensure_desktop_entry() -> Result<(), String> {
    let path = desktop_file_path();
    if std::path::Path::new(&path).exists() {
        return Ok(());
    }
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let content = format!(
        "[Desktop Entry]\nType=Application\nName=ZCode Computer Use Helper\nComment=ZCode Computer Use permission broker helper\nExec=/usr/local/bin/cua-linux-helper\nIcon=applications-system\nTerminal=false\nNoDisplay=true\nCategories=Utility;\n"
    );
    std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))?;
    Ok(())
}

/// 注册 host 应用身份（非沙箱程序必须显式注册，portal 才认得我们）。
///
/// portal 把「D-Bus 连接 ↔ app_id」绑定一次；同一连接上重复 Register 会报
/// "Connection already associated with an application ID"。这不是失败——说明已经注册过了，
/// 按成功处理，否则第二次请求授权会直接报错。
async fn register_app_identity() -> Result<(), String> {
    ensure_desktop_entry()?;
    let app_id = ashpd::AppID::try_from(APP_ID).map_err(|e| format!("AppID: {e}"))?;
    match ashpd::register_host_app(app_id).await {
        Ok(()) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("already associated") {
                eprintln!("[portal] register_host_app: already registered, continue");
                Ok(())
            } else {
                Err(format!("register_host_app: {msg}"))
            }
        }
    }
}

/// 抓一帧屏幕，返回 PNG 字节。
///
/// 走 gstreamer 子进程（`pipewiresrc fd=N path=<node_id> ! videoconvert ! pngenc ! filesink`）
/// 而不是在 Rust 里链接 libpipewire：前者零编译期依赖，用户机器只需有 gstreamer（KDE 桌面
/// 基本自带），后者要求 libpipewire 开发头文件。
///
/// path=<node_id> 是必需的：只传 fd 时 pipewiresrc 找不到目标 node，报
/// `stream error: target not found`（实测 KDE portal-kde）。node id 来自 ScreenCast
/// Start 返回的 Stream.pipewire_node_id。
///
/// 每次调用起一个短生命周期进程：pipewiresrc 收到首帧后 pngenc 写出文件，随即结束。
pub fn capture_frame(state: &Option<PortalSession>) -> Result<Vec<u8>, String> {
    let session = state
        .as_ref()
        .ok_or_else(|| "no portal session; screen capture unavailable".to_string())?;
    let fd = session
        .pipewire_fd
        .as_ref()
        .ok_or_else(|| "no PipeWire fd; screen capture unavailable".to_string())?;
    let node_id = session
        .stream_id
        .ok_or_else(|| "no ScreenCast node id; screen capture unavailable".to_string())?;
    let raw = fd.as_raw_fd();
    // 子进程要继承这个 fd：Rust 默认给 fd 设 CLOEXEC，必须清掉，否则 gst 看不到它。
    let flags = unsafe { libc::fcntl(raw, libc::F_GETFD) };
    if flags >= 0 {
        unsafe { libc::fcntl(raw, libc::F_SETFD, flags & !libc::FD_CLOEXEC) };
    }
    let out = std::env::temp_dir().join(format!("zcode-cua-frame-{}.png", raw));
    let _ = std::fs::remove_file(&out);
    let mut child = std::process::Command::new("gst-launch-1.0")
        .args([
            "-q",
            "pipewiresrc",
            &format!("fd={raw}"),
            // 按官方文档核对过（gst-inspect 属性文档）：target-object 官方推荐但只接受
            // "source name/serial"，node id 传给它在本机 PipeWire 0.3 实测报
            // "target not found"；path 属性虽标 deprecated，其语义正是 node id 且实测
            // 可靠。故用 path。迁移路径：升级 PipeWire 1.x 后改用 serial 作 target-object。
            &format!("path={node_id}"),
            "!",
            "videoconvert",
            "!",
            "pngenc",
            "!",
            "filesink",
            &format!("location={}", out.display()),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("spawn gst-launch-1.0: {e}"))?;
    // 等文件出现且大小稳定（pngenc 写完后才完整）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut last_size = 0u64;
    let mut stable = 0;
    let data = loop {
        if let Ok(meta) = std::fs::metadata(&out) {
            let size = meta.len();
            if size > 0 && size == last_size {
                stable += 1;
                if stable >= 3 {
                    break std::fs::read(&out).map_err(|e| format!("read frame: {e}"));
                }
            } else {
                stable = 0;
            }
            last_size = size;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timed out waiting for screen frame".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
    };
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&out);
    data
}
