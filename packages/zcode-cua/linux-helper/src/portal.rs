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

use std::sync::OnceLock;

use ashpd::desktop::remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions};
use ashpd::desktop::PersistMode;
use tokio::sync::{mpsc, oneshot};

/// Linux evdev 指针按键码（portal NotifyPointerButton 使用 evdev code）。
pub const BTN_LEFT: i32 = 0x110;
pub const BTN_RIGHT: i32 = 0x111;
pub const BTN_MIDDLE: i32 = 0x112;

struct PortalSession {
    desktop: RemoteDesktop,
    session: ashpd::desktop::Session<RemoteDesktop>,
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
    Scroll {
        dx: f64,
        dy: f64,
        resp: oneshot::Sender<Result<(), String>>,
    },
    /// keysym 序列：每个 (keysym, pressed)。
    Keyseq {
        events: Vec<(i32, bool)>,
        resp: oneshot::Sender<Result<(), String>>,
    },
    Status(oneshot::Sender<bool>),
    Reset(oneshot::Sender<()>),
}

static TX: OnceLock<mpsc::UnboundedSender<Cmd>> = OnceLock::new();

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
    eprintln!("[portal] build_session: start (会弹系统授权窗，等待用户确认)");
    let selected = desktop
        .start(&session, None, Default::default())
        .await
        .map_err(|e| format!("start: {e}"))?
        .response()
        .map_err(|e| format!("start response: {e}"))?;
    eprintln!("[portal] build_session: ok, devices={:?}", selected.devices());
    if let Some(t) = selected.restore_token() {
        save_token(t);
    }
    Ok(PortalSession { desktop, session })
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
            let s = match state.as_mut() {
                Some(s) => s,
                None => {
                    let _ = resp.send(Err("needs_grant".into()));
                    return;
                }
            };
            let r = async {
                s.desktop
                    .notify_pointer_motion_absolute(&s.session, 0, x, y, Default::default())
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
        Cmd::Scroll { dx, dy, resp } => {
            let s = match state.as_mut() {
                Some(s) => s,
                None => {
                    let _ = resp.send(Err("needs_grant".into()));
                    return;
                }
            };
            let r = s
                .desktop
                .notify_pointer_axis(&s.session, dx, dy, Default::default())
                .await
                .map_err(|e| format!("axis: {e}"));
            let _ = resp.send(r);
        }
        Cmd::Keyseq { events, resp } => {
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

pub async fn scroll(dx: f64, dy: f64) -> Result<(), String> {
    send_cmd(|resp| Cmd::Scroll { dx, dy, resp }).await?
}

pub async fn key_events(events: Vec<(i32, bool)>) -> Result<(), String> {
    send_cmd(|resp| Cmd::Keyseq { events, resp }).await?
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
