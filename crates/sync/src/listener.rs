use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{Instant, Sleep},
};

pub struct Listener {
    pub tcp: TcpListener,
    pub slots: Arc<Semaphore>,
}
#[derive(Clone)]
pub struct Connection(Arc<Mutex<Transfer>>, pub SocketAddr);
#[derive(Default)]
struct Transfer {
    until: Option<Instant>,
    response: Option<axum::body::Bytes>,
}
impl Connection {
    pub fn response(&self, bytes: axum::body::Bytes, seconds: u64) {
        let mut transfer = self.0.lock().unwrap();
        let next = Instant::now() + Duration::from_secs(seconds);
        transfer.until = Some(transfer.until.map_or(next, |old| old.min(next)));
        transfer.response = Some(bytes);
    }
}
impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, Listener>>
    for Connection
{
    fn connect_info(stream: axum::serve::IncomingStream<'_, Listener>) -> Self {
        stream.io().connection.clone()
    }
}
pub struct Stream {
    connection: Connection,
    send: Pin<Box<Sleep>>,
    tcp: TcpStream,
    _permit: OwnedSemaphorePermit,
    idle: Pin<Box<Sleep>>,
}
impl axum::serve::Listener for Listener {
    type Io = Stream;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Stream, SocketAddr) {
        loop {
            match self.tcp.accept().await {
                Ok((tcp, addr)) => {
                    if let Ok(permit) = self.slots.clone().try_acquire_owned() {
                        return (
                            Stream {
                                tcp,
                                connection: Connection(Arc::default(), addr),
                                send: Box::pin(tokio::time::sleep(Duration::from_secs(120))),
                                _permit: permit,
                                idle: Box::pin(tokio::time::sleep(Duration::from_secs(30))),
                            },
                            addr,
                        );
                    }
                    // Closing an excess TCP connection bounds pre-HTTP and slow-reader memory too.
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }
    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.tcp.local_addr()
    }
}
impl Stream {
    fn active(&mut self) {
        self.idle
            .as_mut()
            .reset(Instant::now() + Duration::from_secs(30));
    }
    fn expired(&mut self, cx: &mut Context<'_>) -> bool {
        if let Some(until) = self.connection.0.lock().unwrap().until {
            self.send.as_mut().reset(until);
            if std::future::Future::poll(self.send.as_mut(), cx).is_ready() {
                return true;
            }
        }
        std::future::Future::poll(self.idle.as_mut(), cx).is_ready()
    }
}
impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.expired(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        let before = buf.filled().len();
        let result = Pin::new(&mut self.tcp).poll_read(cx, buf);
        if buf.filled().len() > before {
            self.active();
        }
        result
    }
}
impl AsyncWrite for Stream {
    fn is_write_vectored(&self) -> bool {
        self.tcp.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        if self.expired(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        let result = Pin::new(&mut self.tcp).poll_write_vectored(cx, bufs);
        if matches!(result, Poll::Ready(Ok(n)) if n > 0) {
            self.active();
        }
        result
    }

    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.expired(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        let result = Pin::new(&mut self.tcp).poll_write(cx, buf);
        if matches!(result,Poll::Ready(Ok(n)) if n>0) {
            self.active();
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.expired(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        Pin::new(&mut self.tcp).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.tcp).poll_shutdown(cx)
    }
}
