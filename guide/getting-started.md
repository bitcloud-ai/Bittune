# Quick Start

## Install

This release supports mainstream glibc Linux x86_64 hosts. Download
`bittune-<version>-linux-x86_64.tar.gz` from GitHub Releases and run:

```bash
tar -xzf bittune-<version>-linux-x86_64.tar.gz
cd bittune-<version>-linux-x86_64
sudo ./install.sh
```

The installer automatically checks the host, detects online or offline package
contents, prepares Node.js and Bittune, and creates `/usr/local/bin/bittune`.
The same `sudo ./install.sh` command is used for an offline package.

The online package downloads production npm dependencies and the pinned Python
measurement tools. The offline package includes Node.js and production npm
dependencies; it never contacts the network, so the optional Python tools are
skipped unless they were already prepared on the host.

After installation, `bittune` works from any directory:

```bash
bittune version
bittune doctor
```

## Configure Agent LLM

```bash
export BITTUNE_AGENT_LLM_API_KEY='your-api-key'
bittune configure \
  --base-url https://endpoint.example.com/v1 \
  --model-id your-tool-capable-model
bittune doctor
```

## Start a session

```bash
bittune
```

## Development

```bash
npm install
npm run check
npm test
npm run package:agent
```
