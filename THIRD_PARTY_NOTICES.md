# Third-party notices

This project (Copyright (c) 2026 Sonic Bold LLC, MIT) includes material derived from the following MIT-licensed projects. Each notice below is reproduced as required by the MIT License. Only MIT-licensed sources were used; no code was taken from unlicensed repositories.

## LobbyStack

- Source: https://github.com/lobbystack/lobbystack
- Commit referenced: c6d0a6644f00a628ceb1339de518405d4967a46b (2026-09-27); voice gateway design from e88a20c0fd6a9045f73472df2d08d38a75a61178, the last commit before it was removed in d8c31ec
- Used for: Base architecture and patterns: pnpm/TypeScript monorepo layout; Postgres per-tenant row-level security (NOLOGIN app role without BYPASSRLS, transaction-local `set_config` tenant context); Twilio webhook signature validation; TwiML escaping; the Twilio Media Streams <-> OpenAI Realtime bridge (session.update shape, audio/pcmu, server VAD, barge-in `clear`, transcript events, function-call round trip); SMS STOP/HELP/START keyword sets and consent tracking. Code was re-implemented and adapted, not vendored; see upstream/LOBBYSTACK-LICENSE.

```
MIT License

Copyright (c) 2026 LobbyStack contributors

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
```

## open-receptionist

- Source: https://github.com/andriidrok1/open-receptionist
- Commit referenced: 087989323e34ba7ecaa0c772251edd02c3888ea5 (2026-08-13)
- Used for: Plumbing/emergency-services domain rules ported from server/businesses/emergency_us.yaml and its rule tests into TypeScript: fee stated early, never quote repair prices, service-area check in code before booking, adult (18+) on site, arrival windows, ignore the caller's word "emergency" in favour of facts, shut-off valve guidance as the only DIY advice, AI disclosure, utility-attributed safety language.

```
MIT License

Copyright (c) 2026 Andrii Drok

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

---

Third-party notices

`server/bot.py` originated from a Pipecat example template and retains its
original copyright header:

    Copyright (c) 2024-2025, Daily
    SPDX-License-Identifier: BSD-2-Clause

The file has since been substantially rewritten, but the notice is kept as
BSD-2-Clause requires. Pipecat itself (https://github.com/pipecat-ai/pipecat)
is BSD-2-Clause licensed and is used here as a dependency.
```

## HomeGuard Rapid Dispatch

- Source: https://github.com/PickleRith/homeguard-rapid-dispatch
- Commit referenced: f369729e18a99078bf49a0b2aef47eeb6f3aa805 (2026-07-29)
- Used for: Emergency triage ported from backend incident_service (classifier.py, priority.py) into TypeScript: P0-P3 levels, P0 safety flags (gas odor, CO alarm, smoke/fire, sparks, water near electrical, injury), negation handling, monotonic (never downgrade) safety flags, reason codes, plumbing intake questions and test scenarios.

```
MIT License

Copyright (c) 2026 HomeGuard Services (fictional demo company)

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
```

## servicetitan-mcp

- Source: https://github.com/montrellcruse/servicetitan-mcp
- Commit referenced: a8bd77eb4af3ba0497e8bc06901d5d884d767154 (2026-09-13)
- Used for: Reference for ServiceTitan API authentication (client-credentials OAuth, ST-App-Key header, tenant-scoped URLs) and the booking-provider bookings endpoint used by the stubbed ServiceTitan adapter. No code copied verbatim.

```
MIT License

Copyright (c) 2026 Montrell Cruse

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
```

## housecallpro-mcp

- Source: https://github.com/NoBanks/housecallpro-mcp
- Commit referenced: 94ee92ecce5f4c9adbce1ab823b302e4056d4449 (2026-05-28)
- Used for: Reference for Housecall Pro API auth (API key header) and customer/job creation shapes used by the stubbed Housecall Pro adapter. No code copied verbatim.

```
MIT License

Copyright (c) 2026 Ryan Hammer (NoBanks Nearby)

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
```
