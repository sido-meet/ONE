//! 壳发往本体的帧，**全部**在这里拼。
//!
//! 为什么要收在一处：协议真相在 `packages/contracts/src/wire.ts`，而壳是 Rust，两边
//! 之间没有任何编译期联系。以前帧散在 `main.rs` 与 `plugin.rs` 各拼各的，于是出现过
//! `clients.launch` 把 `provider` 写成 `kind` —— 本体按不可信输入解析，收不到就整根
//! 管道踢掉，用户点「打开 ONE 桌面端」看到的是**什么都没发生**，日志里只有一行
//! 「收到无法解析的帧」。
//!
//! 所以这里不只放代码，还放着一条测试：每个帧的字段集必须与契约里声明的一致。
//! 契约改了字段名，这里会红，而不是等到有人点那个按钮。

use serde_json::{json, Value};

/// 握手第一帧。
/// `{ t: 'hello'; v: number; client: { role; provider; label; capabilities; view? } }`
/// `view` 是可选的，只有自带页面的插件才申报；客户端（宠物/桌面端）没有页面入口，
/// 所以这里不发它 —— 多发一个空对象会被当成「申报了一个没有入口的页面」。
pub fn hello(v: u32, role: &str, provider: &str, label: &str, capabilities: &[String]) -> Value {
    json!({
        "t": "hello",
        "v": v,
        "client": {
            "role": role,
            "provider": provider,
            "label": label,
            "capabilities": capabilities,
        },
    })
}

/// 拉起一个可视客户端。字段名是 `provider`（寻址键），**不是** `kind` ——
/// `packages/contracts/src/wire.ts`：
/// `{ t: 'clients.launch'; id: string; provider: ProviderId }`
pub fn clients_launch(id: &str, provider: &str) -> Value {
    json!({ "t": "clients.launch", "id": id, "provider": provider })
}

/// 同上，`{ t: 'clients.list'; id: string }`
pub fn clients_list(id: &str) -> Value {
    json!({ "t": "clients.list", "id": id })
}

/// 向某个参与者要一个能力。
/// `{ t: 'capability.call'; id: string; target: ProviderId; capability: string; args?: unknown }`
/// 注意寻址键叫 `target`：同一个字符串在 `clients.launch` 里叫 `provider`，在
/// `page.read` 里也叫 `provider`，只有这里叫 `target` —— 契约如此，不统一。
pub fn capability_call(id: &str, target: &str, capability: &str) -> Value {
    json!({
        "t": "capability.call",
        "id": id,
        "target": target,
        "capability": capability,
    })
}

/// 取插件页面的一段资源。
/// `{ t: 'page.read'; id: string; provider: ProviderId; path: string }`
pub fn page_read(id: &str, provider: &str, path: &str) -> Value {
    json!({ "t": "page.read", "id": id, "provider": provider, "path": path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn keys(frame: &Value) -> BTreeSet<&str> {
        frame.as_object().expect("帧必须是对象").keys().map(String::as_str).collect()
    }

    /// 与 `packages/contracts/src/wire.ts` 里 `ClientMessage` 各分支**逐一对应**。
    /// 契约给字段起别的名字（像 `provider` 一度被写成 `kind`）时这里立刻红。
    const EXPECTED: &[(&str, &[&str])] = &[
        ("clients.launch", &["t", "id", "provider"]),
        ("clients.list", &["t", "id"]),
        ("capability.call", &["t", "id", "target", "capability"]),
        ("page.read", &["t", "id", "provider", "path"]),
    ];

    #[test]
    fn the_handshake_declares_the_client_the_contract_expects() {
        let frame = hello(4, "pet", "pet", "ONE 宠物", &["bubble.open".to_string()]);
        assert_eq!(keys(&frame), ["t", "v", "client"].into_iter().collect());
        let client = frame["client"].as_object().expect("client 是对象");
        assert_eq!(
            client.keys().map(String::as_str).collect::<BTreeSet<&str>>(),
            ["role", "provider", "label", "capabilities"]
                .into_iter()
                .collect::<BTreeSet<&str>>(),
            "客户端自报的那份也要与契约一致"
        );
        assert_eq!(frame["client"]["provider"], "pet", "寻址键叫 provider");
    }

    #[test]
    fn every_shell_frame_carries_the_field_names_the_contract_declares() {
        let built = [
            clients_launch("1", "desktop"),
            clients_list("1"),
            capability_call("1", "pet", "bubble.open"),
            page_read("1", "local.calendar", "index.html"),
        ];
        // 一一配对：EXPECTED 与 built 的顺序必须一致，少一个多一个都要在这里露出来。
        assert_eq!(built.len(), EXPECTED.len(), "有一帧没人守");
        for (frame, (kind, fields)) in built.iter().zip(EXPECTED) {
            assert_eq!(frame["t"], *kind, "这一帧的 t 不对，后面的比对就没意义了");
            assert_eq!(
                keys(frame),
                fields.iter().copied().collect::<BTreeSet<&str>>(),
                "{kind} 的字段名与契约不一致"
            );
        }
    }
}