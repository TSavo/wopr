# WOPR Docker Sandbox

Isolated execution environment for untrusted sessions using Docker containers.

---

## Overview

The sandbox provides defense-in-depth by running untrusted code in isolated Docker containers with:

- **Read-only filesystem**: Prevents persistent modifications
- **No network access**: Prevents data exfiltration
- **Dropped capabilities**: Minimizes kernel attack surface
- **Resource limits**: Prevents denial of service
- **Seccomp profiles**: Filters dangerous syscalls

```
┌─────────────────────────────────────────────────────────────┐
│  Docker Container (wopr-sandbox)                            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  claude-code (or other AI runtime)                  │    │
│  │  - Read, Write, Edit, Bash available                │    │
│  │  - BUT filesystem is read-only                      │    │
│  │  - AND network is blocked                           │    │
│  │  - AND capabilities dropped                         │    │
│  └──────────────────┬──────────────────────────────────┘    │
│                     │ MCP over unix socket                  │
└─────────────────────┼───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│  WOPR Host (a2a-mcp server)                                 │
│                                                             │
│  A2A tool calls filtered by SecurityContext:                │
│  - sessions_send → DENIED (no cross.inject)                 │
│  - http_fetch → DENIED (no inject.network)                  │
│  - memory_read → ALLOWED (filtered paths)                   │
│  - security_whoami → ALLOWED (always)                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

### Docker Installation

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install docker.io

# Add user to docker group
sudo usermod -aG docker $USER

# Verify installation
docker --version
docker run hello-world
```

### Build Sandbox Image

```bash
# Build the sandbox image
wopr sandbox build

# Or manually:
docker build -t wopr-sandbox:latest -f sandbox/Dockerfile .
```

---

## Configuration

### Enable Sandbox for Trust Level

```json
{
  "security": {
    "trustLevels": {
      "untrusted": {
        "sandbox": {
          "enabled": true,
          "network": "none",
          "readOnly": true,
          "memory": "512m",
          "cpus": "0.5",
          "pidsLimit": 100
        }
      }
    }
  }
}
```

### Sandbox Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | false | Enable sandbox isolation |
| `network` | string | "none" | Network mode: none, bridge, host |
| `readOnly` | boolean | true | Read-only root filesystem |
| `memory` | string | "512m" | Memory limit (e.g., "256m", "1g") |
| `cpus` | string | "0.5" | CPU limit (e.g., "0.5", "2") |
| `pidsLimit` | number | 100 | Process ID limit |
| `tmpfsSize` | string | "64m" | Size of /tmp tmpfs |

### Per-Session Override

```json
{
  "security": {
    "sessions": {
      "code-executor": {
        "sandbox": {
          "enabled": true,
          "network": "bridge",
          "memory": "1g",
          "cpus": "1"
        }
      }
    }
  }
}
```

---

## Docker Run Configuration

The sandbox uses these Docker flags:

```bash
docker run \
  --read-only \                           # Read-only root filesystem
  --tmpfs /tmp:size=64m,mode=1777 \       # Writable /tmp (limited)
  --tmpfs /var/tmp:size=64m,mode=1777 \   # Writable /var/tmp
  --network none \                        # No network access
  --cap-drop ALL \                        # Drop all Linux capabilities
  --security-opt no-new-privileges \      # Prevent privilege escalation
  --security-opt seccomp=wopr-seccomp.json \  # Syscall filtering
  --pids-limit 100 \                      # Process limit
  --memory 512m \                         # Memory limit
  --memory-swap 512m \                    # No swap (same as memory)
  --cpus 0.5 \                            # CPU limit
  --ulimit nofile=1024:1024 \             # File descriptor limits
  -v /workspace:/workspace:ro \           # Session workspace (read-only)
  -v /tmp/wopr-socket:/tmp/wopr-socket \  # MCP socket
  wopr-sandbox:latest
```

---

## Network Modes

### none (Default - Most Secure)

No network access. Container is completely isolated.

```json
{ "network": "none" }
```

**Use for**: Untrusted code execution, sensitive operations

### bridge

Container has its own network namespace but can make outbound connections.

```json
{ "network": "bridge" }
```

**Use for**: Semi-trusted code that needs HTTP access (filtered by A2A)

### host (Least Secure)

Container shares host's network namespace.

```json
{ "network": "host" }
```

**Use for**: Testing only. Not recommended for production.

---

## Seccomp Profile

The sandbox uses a custom seccomp profile to filter dangerous syscalls:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": [
        "read", "write", "open", "close", "stat", "fstat",
        "lstat", "poll", "lseek", "mmap", "mprotect", "munmap",
        "brk", "rt_sigaction", "rt_sigprocmask", "ioctl",
        "access", "pipe", "select", "sched_yield", "mremap",
        "msync", "mincore", "madvise", "dup", "dup2", "pause",
        "nanosleep", "getpid", "socket", "connect", "accept",
        "sendto", "recvfrom", "bind", "listen", "getsockname",
        "getpeername", "socketpair", "setsockopt", "getsockopt",
        "clone", "fork", "execve", "exit", "wait4", "kill",
        "uname", "fcntl", "flock", "fsync", "fdatasync",
        "truncate", "ftruncate", "getdents", "getcwd", "chdir",
        "rename", "mkdir", "rmdir", "creat", "link", "unlink",
        "symlink", "readlink", "chmod", "chown", "lchown",
        "umask", "gettimeofday", "getuid", "getgid", "geteuid",
        "getegid", "getppid", "getpgrp", "setsid", "setuid",
        "setgid", "getgroups", "setgroups", "setresuid",
        "setresgid", "getresuid", "getresgid", "sigaltstack",
        "rt_sigreturn", "mknod", "statfs", "fstatfs", "sysinfo",
        "times", "ptrace", "syslog", "setpgid", "getpgid",
        "getsid", "capget", "capset", "sendfile", "vfork",
        "getrlimit", "setrlimit", "getrusage", "prctl",
        "arch_prctl", "futex", "set_tid_address", "epoll_create",
        "epoll_ctl", "epoll_wait", "exit_group", "tgkill",
        "openat", "mkdirat", "fchownat", "fstatat", "unlinkat",
        "renameat", "linkat", "symlinkat", "readlinkat",
        "fchmodat", "faccessat", "pselect6", "ppoll",
        "set_robust_list", "get_robust_list", "splice", "tee",
        "sync_file_range", "epoll_pwait", "eventfd", "eventfd2",
        "epoll_create1", "dup3", "pipe2", "inotify_init1",
        "preadv", "pwritev", "accept4", "signalfd4",
        "getrandom", "memfd_create", "execveat", "copy_file_range"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

### Blocked Syscalls

The following dangerous syscalls are blocked:

| Syscall | Risk |
|---------|------|
| `reboot` | System shutdown |
| `kexec_load` | Kernel replacement |
| `init_module` / `delete_module` | Kernel module loading |
| `mount` / `umount` | Filesystem mounting |
| `pivot_root` | Root filesystem change |
| `chroot` | Escape isolation |
| `setns` | Namespace manipulation |
| `unshare` | Privilege escalation |

---

## Resource Limits

### Memory

```json
{ "memory": "512m" }
```

Container is OOM-killed if it exceeds the limit.

### CPU

```json
{ "cpus": "0.5" }
```

Container gets at most 50% of one CPU core.

### Process IDs

```json
{ "pidsLimit": 100 }
```

Prevents fork bombs. Container cannot create more than 100 processes.

### File Descriptors

Default ulimit: 1024 open files.

---

## Sandbox API

### Check Availability

```typescript
import { isDockerAvailable, isSandboxImageAvailable } from "@wopr/core/security";

const dockerOk = await isDockerAvailable();
const imageOk = await isSandboxImageAvailable();

if (!dockerOk) {
  console.log("Docker not available");
} else if (!imageOk) {
  console.log("Sandbox image not built. Run: wopr sandbox build");
}
```

### Create Sandbox

```typescript
import { createSandbox } from "@wopr/core/security";

const sandbox = await createSandbox("untrusted-session", {
  network: "none",
  readOnly: true,
  memory: "512m",
  cpus: "0.5"
});

console.log(sandbox.containerId);  // "abc123..."
```

### Execute in Sandbox

```typescript
import { execInSandbox } from "@wopr/core/security";

const result = await execInSandbox(sandbox.containerId, "ls -la /workspace", {
  timeout: 30000,
  cwd: "/workspace"
});

console.log(result.stdout);
console.log(result.exitCode);
```

### Destroy Sandbox

```typescript
import { destroySandbox } from "@wopr/core/security";

await destroySandbox(sandbox.containerId);
```

### List Sandboxes

```typescript
import { listSandboxes } from "@wopr/core/security";

const sandboxes = await listSandboxes();
for (const sb of sandboxes) {
  console.log(`${sb.sessionName}: ${sb.status}`);
}
```

### Cleanup All

```typescript
import { cleanupAllSandboxes } from "@wopr/core/security";

await cleanupAllSandboxes();  // Destroys all sandbox containers
```

---

## CLI Commands

### Build Sandbox Image

```bash
wopr sandbox build

# With custom Dockerfile
wopr sandbox build --dockerfile ./custom/Dockerfile

# Force rebuild
wopr sandbox build --force
```

### List Running Sandboxes

```bash
wopr sandbox list

# Output:
# SESSION           CONTAINER ID   STATUS    MEMORY   CPU
# untrusted-1       abc123         running   128m     5%
# code-executor     def456         running   256m     12%
```

### Destroy Sandbox

```bash
# Destroy specific sandbox
wopr sandbox destroy abc123

# Destroy all sandboxes
wopr sandbox destroy --all
```

### Check Status

```bash
wopr sandbox status

# Output:
# Docker: available
# Image: wopr-sandbox:latest (built 2024-01-15)
# Running: 2 sandboxes
# Memory: 384m / 4g total
```

---

## Sandbox Image

### Dockerfile

```dockerfile
FROM debian:bookworm-slim

# Install minimal dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install claude-code
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -s /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox

# Entry point
ENTRYPOINT ["/bin/bash"]
```

### Custom Image

To use a custom sandbox image:

```json
{
  "security": {
    "sandbox": {
      "image": "my-custom-sandbox:v1"
    }
  }
}
```

---

## MCP Communication

The sandbox communicates with WOPR via Unix socket:

### Host Side

```typescript
// Create socket for MCP communication
const socketPath = `/tmp/wopr-${sessionName}.sock`;
const server = net.createServer((socket) => {
  // Handle MCP protocol
  handleMcpConnection(socket, securityContext);
});
server.listen(socketPath);
```

### Container Side

```typescript
// Connect to host MCP server
const socket = net.connect('/tmp/wopr-socket/mcp.sock');
// Send MCP requests through socket
```

### Security Filtering

The host MCP server filters tools based on the session's security context:

```typescript
function handleMcpToolCall(tool: string, args: any, ctx: SecurityContext) {
  // Check if tool is allowed
  if (!ctx.isToolAllowed(tool)) {
    return { error: "Tool not allowed" };
  }

  // Execute tool
  return executeTool(tool, args);
}
```

---

## Troubleshooting

### "Docker not available"

Docker daemon not running or not accessible.

```bash
# Check Docker status
sudo systemctl status docker

# Start Docker
sudo systemctl start docker

# Check permissions
docker ps  # Should work without sudo after adding to docker group
```

### "Sandbox image not found"

Image hasn't been built.

```bash
wopr sandbox build
```

### "Container OOM killed"

Memory limit exceeded.

```json
{ "memory": "1g" }  // Increase memory limit
```

### "Network unreachable" (expected in sandbox)

Container has `network: "none"`. This is expected behavior.

If network access is needed, change to `network: "bridge"` (less secure).

### "Permission denied" in container

Filesystem is read-only. Use `/tmp` for temporary files.

```bash
# Works
echo "test" > /tmp/test.txt

# Fails
echo "test" > /home/sandbox/test.txt
```

---

## Security Considerations

### Escape Prevention

Multiple layers prevent container escape:

1. **Capability dropping**: `--cap-drop ALL`
2. **No new privileges**: `--security-opt no-new-privileges`
3. **Seccomp profile**: Blocks dangerous syscalls
4. **Read-only filesystem**: No persistent modifications
5. **Resource limits**: Prevent resource exhaustion

### Host Protection

- Workspace mounted read-only
- No host network access (default)
- No privileged operations
- No device access

### Data Protection

- No network = no exfiltration (with `network: "none"`)
- A2A tools filtered server-side
- Sensitive paths excluded from mounts

---

## Performance Impact

| Metric | Impact |
|--------|--------|
| Startup | +1-2 seconds (container creation) |
| Execution | Minimal (native performance) |
| Memory | +50-100MB per container |
| I/O | Slightly slower (filesystem layers) |

For latency-sensitive operations, consider using capabilities-only restrictions instead of full sandbox.

---

## Related Documentation

- [SECURITY.md](./SECURITY.md) - Security model overview
- [SECURITY_CONFIG.md](./SECURITY_CONFIG.md) - Configuration reference
- [SECURITY_API.md](./SECURITY_API.md) - API reference
- [GATEWAY.md](./GATEWAY.md) - Gateway session details
- [DOCKER.md](./DOCKER.md) - General Docker usage
