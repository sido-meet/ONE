//! Windows 系统代理（ADR-031）。
//!
//! **为什么注册表留在这个边界里**：Node 既不读系统代理，也没有 `NODE_USE_ENV_PROXY`
//! （Node 24 才有）。本体是 TypeScript 源码随包跑的，让它去读注册表就得在 core 里塞一
//! 段 Windows 专用的 FFI，而 core 的形状是「零第三方依赖 + 跨平台路径」（ADR-021/030）。
//! 注册表是 Windows 宿主的事，就该由壳读，再经环境变量递给本体 —— 那边只认
//! `host:port` 一个字符串，不需要知道那是从哪儿来的。
//!
//! 用 `windows-sys` 而不是新引一个 `winreg`：它已经是本项目的直接依赖（管道就在用它），
//! 多开一个 feature 比多一个 crate 便宜得多，而一个不写平台的 Rust 应用谈「零依赖」
//! 有点晚了 —— 真正要守住的是**本体**那边的零依赖。

use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    REG_DWORD,
};

const INTERNET_SETTINGS: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 读一个 `REG_SZ`。读不到或形状不对一律 `None` —— **不猜**。
fn read_string(key: HKEY, name: &str) -> Option<String> {
    let value_name = wide(name);
    // 第一次调用只问长度：这是注册表 API 的标准两段式，也是唯一不踩「缓冲区给小了
    // 就会按需扩写、于是同一段代码在不同机器上行为不同」这个坑的写法。
    let mut size: u32 = 0;
    let ok = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if ok != 0 || size == 0 {
        return None;
    }
    let mut buffer = vec![0u16; size as usize / 2];
    let mut got = size;
    let ok = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut got,
        )
    };
    if ok != 0 {
        return None;
    }
    let text = String::from_utf16_lossy(&buffer);
    // 缓冲区里通常带一个结尾的 NUL。留着它的话地址会变成 `127.0.0.1:7897\0`，
    // 拼进 URL 之后连不上 —— 而症状是「代理开着却说连不上」。
    let text = text.trim_end_matches('\0').trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn read_dword(key: HKEY, name: &str) -> Option<u32> {
    let value_name = wide(name);
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let mut kind: u32 = 0;
    let ok = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    (ok == 0 && kind == REG_DWORD).then_some(data)
}

/**
 * 把注册表里那个字符串整理成「主机 + 端口」。
 *
 * 系统代理的值有三种常见写法，形状完全不同：
 * - `127.0.0.1:7897` —— 一个地址管所有协议；
 * - `http=127.0.0.1:7897;https=127.0.0.1:7899` —— 按协议分开；
 * - `socks=127.0.0.1:1080` —— 本项目**不认**（CONNECT 隧道是 HTTP 代理的形状，
 *   SOCKS 的话就是另一套握手）。
 *
 * 分协议时**优先取 https**，没有再退回 http：我们要访问的就是 https。取错协议的话
 * 症状是「代理地址明明对，就是连不上」。
 */
pub fn parse_proxy_server(value: &str) -> Option<(String, u16)> {
    let entry = if value.contains('=') {
        let mut https = None;
        let mut http = None;
        for part in value.split(';') {
            let (scheme, rest) = part.split_once('=')?;
            let address = rest.trim();
            match scheme.trim().to_ascii_lowercase().as_str() {
                "https" => https = Some(address.to_string()),
                "http" => http = Some(address.to_string()),
                _ => {}
            }
        }
        https.or(http)?
    } else {
        value.trim().to_string()
    };
    // 有些机器把地址写成 `http://127.0.0.1:7897`，连默认端口都不给。
    let entry = entry
        .strip_prefix("http://")
        .or_else(|| entry.strip_prefix("https://"))
        .unwrap_or(&entry)
        .trim_end_matches('/');
    let (host, port) = entry.rsplit_once(':')?;
    let port: u16 = port.trim().parse().ok()?;
    let host = host.trim();
    (!host.is_empty() && port > 0).then(|| (host.to_string(), port))
}

/// 本机当前生效的系统代理。**没开就 `None`，本体于是直连**（ADR-031）。
pub fn system_proxy() -> Option<(String, u16)> {
    let subkey = wide(INTERNET_SETTINGS);
    let mut key: HKEY = std::ptr::null_mut();
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_READ,
            &mut key,
        )
    };
    if opened != 0 {
        return None;
    }
    // `ProxyEnable` 为 0 时 `ProxyServer` 往往还留着上一次的地址。只看有没有那个
    // 字符串的话，用户的代理早就关了而 ONE 还在往一个死地址上连 —— 而且症状是
    // 「连接被拒」，用户会去查防火墙。
    let enabled = read_dword(key, "ProxyEnable").unwrap_or(0);
    // 括号是必需的：`enabled == 1.then(…)` 会把 `.then` 绑到字面量 `1` 上，
    // 于是这段永远返回 `false == 某值`，编译还过得去。
    let server = if enabled == 1 {
        read_string(key, "ProxyServer")
    } else {
        None
    };
    unsafe { RegCloseKey(key) };
    server.and_then(|value| parse_proxy_server(&value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_host_and_port_is_enough() {
        assert_eq!(
            parse_proxy_server("127.0.0.1:7897"),
            Some(("127.0.0.1".into(), 7897))
        );
    }

    #[test]
    fn the_https_entry_wins_over_the_http_one() {
        // 取错协议的症状是「地址明明对，就是连不上」。
        assert_eq!(
            parse_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7897"),
            Some(("127.0.0.1".into(), 7897))
        );
    }

    #[test]
    fn a_list_without_https_falls_back_to_http() {
        assert_eq!(
            parse_proxy_server("http=10.0.0.2:3128"),
            Some(("10.0.0.2".into(), 3128))
        );
    }

    #[test]
    fn a_scheme_prefix_is_stripped() {
        // 少了这一步，主机名会变成 `http`，连上去的是一个不存在的名字。
        assert_eq!(
            parse_proxy_server("http://127.0.0.1:7897/"),
            Some(("127.0.0.1".into(), 7897))
        );
    }

    #[test]
    fn socks_is_not_accepted() {
        // CONNECT 隧道是 HTTP 代理的形状。认了 socks 就会拿 HTTP 的握手去敲它，
        // 失败得莫名其妙。
        assert_eq!(parse_proxy_server("socks=127.0.0.1:1080"), None);
    }

    #[test]
    fn nonsense_is_not_guessed() {
        for value in ["", "127.0.0.1", "127.0.0.1:abc", ":7897", "127.0.0.1:0"] {
            assert_eq!(parse_proxy_server(value), None, "{value} 不该被猜出地址");
        }
    }
}
