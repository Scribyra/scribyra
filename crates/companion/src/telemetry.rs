use scribyra_core::telemetry::{Operation, TraceContext, native};
tokio::task_local! {static PARENT: Option<TraceContext>;}
pub fn begin(operation: Operation) -> native::Span {
    let parent = PARENT.try_with(Clone::clone).ok().flatten();
    native::global().begin(operation, parent.as_ref())
}
pub async fn scope<T>(
    context: Option<TraceContext>,
    future: impl std::future::Future<Output = T>,
) -> T {
    PARENT.scope(context, future).await
}
