# Third-party notices

## browser-use/jev-ultrafast

https://github.com/browser-use/jev-ultrafast

KYRN's built-in browser is a TypeScript port of the ideas in jev-ultrafast. The
in-page snapshot script in `src/browser/snapshot.ts` is adapted from its
`snapshot.js`. The step design in `src/decisions/browser-step.ts` (one judge
request per step with an operation choice plus one target choice per available
operation, goal-level rules, a small text model only for typed values) and the
freshness guards in `src/browser/session.ts` follow its `questions.py`,
`agent.py` and `browser.py`.

MIT License

Copyright (c) 2026 Browser Use

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
