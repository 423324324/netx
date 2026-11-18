# netx-probe

**Know the speed before you wait for it.** Measure real throughput to a host, predict the
download time, and find out which mirror is actually fast on *your* network — before you
start a 10-minute download that was never going to finish.

Zero dependencies. Node >= 18. Single file. Works on Windows, macOS, Linux.

```bash
npx netx-probe probe        # rank npm / pypi / github endpoints by real speed
npx netx-probe eta <url>    # "how long will this take?" — measured, not guessed
npx netx-probe get <url> -o file.tar.gz   # download with ETA + stall detection
npx netx-probe fix          # print the config commands for the fastest mirror
```

## Why

On many networks the difference between a 40-second install and a 10-minute one is *which
endpoint you hit*, not the package size. Measured on a real Windows machine (2026-11-18):

| ecosystem | endpoint | speed |
|---|---|---|
| npm | `registry.npmjs.org` | **0.11 MB/s** |
| npm | `registry.npmmirror.com` | 6.30 MB/s |
| npm | `repo.huaweicloud.com` | **7.15 MB/s** |
| pypi | `pypi.org/simple` | **0.05 MB/s** |
| pypi | `mirrors.aliyun.com` | **1.93 MB/s** |
| pypi | `pypi.tuna.tsinghua.edu.cn` | HTTP 403 |
| github | `github.com` | connection reset |
| github | `codeload.github.com` (tarball) | 0.02 MB/s — slow but alive |
| github | `gh-proxy.com` (tarball via proxy) | 0.08 MB/s |

That is a 65x spread on npm and 38x on pypi, on the same machine, same minute. `netx probe`
turns that from folklore into a number you can act on.

## What each command really does

### `netx probe [npm|pypi|github|all]`

Streams 256 KB from every candidate endpoint, measures **TTFB separately from throughput**,
and sorts by throughput. Important detail: a probe that times out *after* delivering bytes is
reported as `slow-but-alive`, never as dead — that distinction is what stops you from
abandoning a working (if slow) source.

### `netx eta <url>`

1. Asks for the total size (`HEAD`, falling back to a 1-byte range request).
2. Streams up to 512 KB and measures steady-state throughput *after* the first byte.
3. Prints the ETA, and if the server sends no `content-length`, prints a "at this speed: 10 MB
   → X, 100 MB → Y" table instead of lying with a made-up number.
4. Warns on `<50 KB/s` ("switch mirror before downloading") and on high latency.

The ETA is a projection from a real sample of *this* URL on *this* network, not a guess from a
file-size table. It is accurate as long as throughput is roughly stable — which the tool tells
you when it isn't.

### `netx get <url> -o <file>`

- Progress bar, instantaneous speed, ETA, TTFB.
- **Resume**: if the file exists and the server supports ranges, it continues where it stopped.
- **Stall detection**: no bytes for 20 s (configurable with `--stall-ms`) → abort with exit
  code 4 and a hint to re-probe the mirror, instead of hanging silently.

### `netx fix`

Prints the `npm config set registry`, `pip config set global.index-url`, `UV_DEFAULT_INDEX`
and GitHub-tarball commands for whichever endpoint just won on your network.

## Exit codes

| code | meaning |
|---|---|
| 0 | ok |
| 2 | bad usage |
| 3 | HTTP / request error |
| 4 | stalled (no data for `--stall-ms`) |
| 5 | stream error mid-download |

## Notes / limits

- Throughput is sampled, so a very fast link (<2 s total) makes the ETA coarse by design.
- Some CDNs ignore `Range`; the tool detects that and restarts the file instead of corrupting it.
- GitHub probing uses a real tarball on purpose: `github.com` root can be blocked while
  `codeload` works, and a tarball is what you actually download.
- No telemetry, no config files, no daemon. Nothing runs unless you run it.

## Roadmap

- `netx watch <cmd>` — wrap an install command, detect slowness from its output, and retry it
  against a mirror automatically.
- Per-ecosystem endpoint overrides via `netx.json`.

## License

MIT
