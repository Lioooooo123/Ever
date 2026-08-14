# Changelog

## [Unreleased]

### Changed

- Clarified that the library is currently consumed from the Ever workspace while the public npm release ships the CLI.
- Changed OpenAI Responses deferred tool loading to prefer message-anchored `additional_tools` where supported while retaining tool-search and top-level fallbacks.
- Replaced the Mistral SDK transport with a native Chat Completions HTTP stream, eliminating its generated client and schema runtime overhead.

### Fixed

- Fixed upstream request buffer limit failures to trigger automatic assistant retries.
- Fixed OpenAI Responses function and custom tool calls to preserve namespaces during streaming, proxying, and replay.
- Fixed built-in and custom DeepSeek API models to send output limits through the supported `max_tokens` field.
