// A new ChatGPT turn may navigate / -> /c/local-chatgpt -> /c/:id.
// The same in-flight request must retain its model and policy correlation.
// Ordinary navigation between two real conversations must reset that epoch.
export function isActiveNewChatRequestHandoff(previousContextKey, nextContextKey, request, now = Date.now()) {
  const fromNewChat = typeof previousContextKey === 'string'
    && (previousContextKey.startsWith('page:') || previousContextKey === 'conversation:local-chatgpt');
  const toConversation = typeof nextContextKey === 'string'
    && nextContextKey.startsWith('conversation:')
    && nextContextKey.length > 'conversation:'.length;
  const requestTime = Date.parse(request?.capturedAt || '');
  return fromNewChat && toConversation
    && Boolean(request?.requestId)
    && Number.isFinite(requestTime)
    && now - requestTime >= 0
    && now - requestTime < 15 * 60 * 1000;
}
