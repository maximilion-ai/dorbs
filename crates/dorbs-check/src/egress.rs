//! The only way out of the setup network: an HTTPS CONNECT proxy that reaches package registries
//! and nothing else. It runs in a container of its own on both the setup network and the default
//! bridge. It allows the hosts the adapters' `egress` lists name, or EGRESS_ALLOW's: a
//! comma-separated list, a leading dot for a domain.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Whether `host:port` is a listed host, or under a listed `.domain`, on an allowed port.
pub fn is_allowed(host: &str, port: u16, allow: &[String], ports: &[u16]) -> bool {
    ports.contains(&port)
        && allow.iter().any(|entry| match entry.strip_prefix('.') {
            Some(_) => host.ends_with(entry.as_str()) && host.len() > entry.len(),
            None => host == entry,
        })
}

/// The hosts in a comma-separated EGRESS_ALLOW.
pub fn allow_list(list: &str) -> Vec<String> {
    list.split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Serves the proxy; `ports` is [443] but in tests.
pub async fn serve(
    listener: TcpListener,
    allow: Vec<String>,
    ports: Vec<u16>,
) -> std::io::Result<()> {
    let rules = std::sync::Arc::new((allow, ports));
    loop {
        let (client, _) = listener.accept().await?;
        let rules = rules.clone();
        tokio::spawn(async move {
            let _ = tunnel(client, &rules.0, &rules.1).await;
        });
    }
}

/// Tunnels one allowed CONNECT and refuses every other request.
async fn tunnel(mut client: TcpStream, allow: &[String], ports: &[u16]) -> std::io::Result<()> {
    let mut head = Vec::new();
    let mut buffer = [0u8; 4096];
    let end = loop {
        let read = client.read(&mut buffer).await?;
        if read == 0 {
            return Ok(());
        }
        head.extend_from_slice(&buffer[..read]);
        if let Some(at) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        if head.len() > 16 * 1024 {
            return client
                .write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n")
                .await;
        }
    };
    let line = String::from_utf8_lossy(&head[..head.iter().position(|&b| b == b'\r').unwrap_or(0)])
        .into_owned();
    let mut words = line.split(' ');
    let (method, target) = (
        words.next().unwrap_or_default(),
        words.next().unwrap_or_default(),
    );
    if method != "CONNECT" {
        crate::log(&format!("refused {method} {target}"));
        return client
            .write_all(b"HTTP/1.1 403 Forbidden\r\n\r\nOnly HTTPS to package registries.\n")
            .await;
    }
    let parsed = target.rsplit_once(':').and_then(|(host, port)| {
        let valid = !host.is_empty()
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
        valid.then_some((host.to_ascii_lowercase(), port.parse::<u16>().ok()?))
    });
    let Some((host, port)) = parsed.filter(|(host, port)| is_allowed(host, *port, allow, ports))
    else {
        crate::log(&format!("refused CONNECT {target}"));
        return client.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n").await;
    };
    let mut upstream = match TcpStream::connect((host.as_str(), port)).await {
        Ok(upstream) => upstream,
        Err(_) => return client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await,
    };
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    upstream.write_all(&head[end..]).await?;
    tokio::io::copy_bidirectional(&mut client, &mut upstream)
        .await
        .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_listed_hosts_on_443_or_a_listed_domains_subdomains() {
        let allow: Vec<String> = ["registry.npmjs.org", ".pythonhosted.org"]
            .map(str::to_owned)
            .to_vec();
        let allowed = |host: &str, port: u16| is_allowed(host, port, &allow, &[443]);
        assert!(allowed("registry.npmjs.org", 443));
        assert!(allowed("files.pythonhosted.org", 443));
        assert!(!allowed("pythonhosted.org", 443));
        assert!(!allowed(".pythonhosted.org", 443));
        assert!(!allowed("registry.npmjs.org", 80));
        assert!(!allowed("registry.npmjs.org.evil.com", 443));
        assert!(!allowed("evilregistry.npmjs.org", 443));
    }

    #[tokio::test]
    async fn tunnels_a_connect_to_an_allowed_host_and_refuses_the_rest() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = upstream.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = upstream.accept().await.unwrap();
            let mut got = [0u8; 4];
            socket.read_exact(&mut got).await.unwrap();
            socket.write_all(&got).await.unwrap();
        });
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = proxy.local_addr().unwrap();
        tokio::spawn(serve(proxy, vec!["localhost".to_owned()], vec![port]));
        let ask = |request: String| async move {
            let mut socket = TcpStream::connect(address).await.unwrap();
            socket.write_all(request.as_bytes()).await.unwrap();
            let mut answer = vec![0u8; 256];
            let n = socket.read(&mut answer).await.unwrap();
            (socket, String::from_utf8_lossy(&answer[..n]).into_owned())
        };
        let (_, refused) =
            ask("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n".into()).await;
        assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");
        let (_, elsewhere) = ask("CONNECT example.com:443 HTTP/1.1\r\n\r\n".into()).await;
        assert!(elsewhere.starts_with("HTTP/1.1 403"), "{elsewhere}");
        let (_, wrong_port) = ask("CONNECT localhost:443 HTTP/1.1\r\n\r\n".into()).await;
        assert!(wrong_port.starts_with("HTTP/1.1 403"), "{wrong_port}");
        let (mut socket, open) = ask(format!("CONNECT localhost:{port} HTTP/1.1\r\n\r\n")).await;
        assert_eq!(open, "HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.write_all(b"ping").await.unwrap();
        let mut echoed = [0u8; 4];
        socket.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping");
    }
}
