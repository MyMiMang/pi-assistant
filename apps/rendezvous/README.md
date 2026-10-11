# rendezvous

Cloudflare Worker + KV：稳定入口，保存 serverId → 当前隧道地址（Ed25519 签名），不经手任何内容。详见 docs/DESIGN.md §5.13.2。
