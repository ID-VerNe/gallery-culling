# A — CLI / MCP / 命令层 ↔ Rust 桥接层

> 比对对象：宿主 `gallery-flask`（Tauri 2.0 + Rust + React）↔ 客体 `lumen-raw` v1.6.0（commit `43b4ebe`）。
> 决策前提：进程级 sidecar 混合桥接 —— A. `lumen-cli mcp` 常驻 stdio（主循环）+ B. `lumen-cli run` 单发 + C. 命名管道直连编辑器（可选）；否决 PyO3 / Rust 移植。
> 两仓库只读。行号格式 `cli.py:NN`（客体）/ `commands.rs:NN`、`luminar.rs:NN`、`api.ts:NN`、`Cargo.toml:NN`（宿主）。

---

## 0. 结论摘要（TL;DR）

1. **lumen 已经把"命令层"做成了唯一事实源**：27 条命令（`commands.py:49-56` REGISTRY）+ 24 个 MCP 工具名 + 1 个 `run_command` 逃生舱
   （`mcp.py:50-54`），全部带 JSON Schema（`commands.py:44-46`）。宿主**不需要**自己拼参数结构，只需要忠实转发。
2. **三条通道的报文字法完全不同，宿主必须各写一个编解码器**：
   - MCP stdio = newline-delimited JSON-RPC 2.0（`mcp.py:97`，`separators=(',',':')`，**无 Content-Length 头**）；
   - `lumen-cli run` = 一次性进程，stdout 是**美化** JSON（`cli.py:53` `indent=2`），stderr 只有 `lumen-cli: <msg>`，exit 1（`cli.py:215-217`）；
   - 命名管道 = JSON lines，请求 `{"id","command","args"}`、应答 `{"id","ok","result"|"error"}`（`control.py:98` / `control.py:407-413`）。
3. **MCP 有双时代协议分支**（`mcp.py:24-26`）：legacy 客户端走 `initialize`（`mcp.py:147-151`），2026-07-28 客户端走 `server/discover`
   且在**每个请求**的 `params._meta["io.modelcontextprotocol/protocolVersion"]` 里带版本（`mcp.py:142-146`）。
   **宿主应当只做 legacy 客户端**：发一次 `initialize`，拿普通 `tools/list`，绕开 `_modern` 包装（`mcp.py:170-172`）和 `ttlMs/cacheScope` 噪音。
4. **`render_preview` 的图片是 base64 塞在 `result['image']`**（`commands.py:536-537`），MCP 侧转成 `content[0]` image block 并**从
   `structuredContent` 里删掉该键**（`mcp.py:190-192`）。宿主要么解析 `content[]` 数组，要么走 B 通道 `run render.preview` 带
   `output=` 落盘（`cli.py:218-219` 会把 `image` 键从 stdout 结果里剥掉）——**推荐后者，宿主零 base64 解码依赖**。
5. **命名管道没有请求 id 校验**：`Client.call` 只递增本地 `self._ids` 然后读下一行，**从不比对应答 id**（`control.py:96-105`）。
   因此一条连接**同一时刻只能有一个 in-flight 请求**；MCP 侧的用法是"每次调用新建 Client、用完即关"（`mcp.py:75-82`）。宿主照抄这个模式即可。
6. **超时责任全在客户端**：`Client` 没有任何读超时（`control.py:90-94` 裸 `read`）；服务端唯一超时是 `Bridge.call` 的 300s
   （`control.py:149-155`）和 `WindowContext.open` 的 30s/300s 截止（`control.py:207-222`）。宿主必须自建超时与崩溃重启。
7. **lumen 没有任何"宿主 session / 选片状态"概念**：`Session` 每次进程都是全新的，当前图、库、选区全空（`session.py:24-90`）。
   B 通道的每一次 `run` 都**必须自带显式 `path`**，绝不能依赖"上一张还开着"。
8. **版本握手必须显式断言**：`initialize` 应答带 `serverInfo.version`（`mcp.py:150-151`），`app.status` 也返回 `version`
   （`commands.py:200`）。宿主启动时断言 `== "1.6.0"`，否则禁用 RAW 链路并提示升级（钉死 commit `43b4ebe`）。

---

## 1. `lumen/cli.py` 全部子命令契约

### 1.1 全局行为（`main` `cli.py:118-221`）

| 项 | 证据 | 契约 |
|---|---|---|
| stdout 编码 | `cli.py:120-122` `reconfigure(encoding='utf-8', errors='replace')` | 宿主读 stdout 一律按 UTF-8 解；非法字节被替换而非报错 |
| 日志去向 | `cli.py:123-124` `logs.configure(filename='lumen-cli.log')` → `logs.py:26-33` 旋转文件 `%LOCALAPPDATA%\LUMEN RAW\logs\lumen-cli.log` | **stderr 不含日志**，仅错误；宿主可把 stderr 当纯错误流读 |
| 结果输出 | `cli.py:52-53` `_dump`：`json.dumps(..., ensure_ascii=False, indent=2) + '\n'` | **美化 JSON + 尾部换行**；宿主 `serde_json::from_slice` 可直接吃，但**不能假设单字节流式**——只在进程退出后一次性读 |
| 图片剥离 | `cli.py:218-219` 若 `result` 含 `image` 键则删除后再 dump | B 通道 `run render.preview` 默认**不**返回 base64；必须传 `output=` 才能拿到文件 |
| exit code | 成功 `return 0`（`cli.py:221`）；`CommandError/ValueError/OSError` → stderr `lumen-cli: {exc}` + `return 1`（`cli.py:215-217`） | 0=成功；1=lumen 侧业务/IO 错误；**argparse 用法错误 = 2**（`cli.py:125,162`，宿主 bug）。未捕获异常（`KeyError` 等）也以 1 退出但 stderr 是 traceback —— 一律按"exit≠0 即失败 + stderr 原文透出"处理 |
| `--version` | `cli.py:126` `action='version'` | `lumen-cli --version` → `LUMEN RAW 1.6.0`，退出 0。**B 通道预检的最便宜手段** |

### 1.2 子命令一览

| 子命令 | 参数（`cli.py` 行） | 分发路径 | stdout JSON 形状 | 备注 |
|---|---|---|---|---|
| `render` | `input` `output` `--size` `--quality=92` `--preset` `--amount=100` `--set K=V`(repeat) `--process {1,2}` `--overwrite`（`cli.py:128-138`） | `render()` `cli.py:89-115`：**强制 headless `Session()`**（`cli.py:92`）→ `photo.open`(:94) → `edit.process`(:95-96) → `edit.preset`(:97-98) → `edit.apply`(:112-113) → `photo.export`(:114) | `{path, output}`（`commands.py:569`） | **永不走 GUI**（`cli.py:92` 直接 `Session()`），适合 B 通道重活；失败即 exit 1 |
| `info` | `photo`（`cli.py:139-140`） | `photo.info`，路径先 `Path().resolve()`（`cli.py:176`） | `{path, name, width, height, format, raw, note, exif}`（`commands.py:351` + `_info` `commands.py:342-343`） | `_info` 丢 `gps`、只留标量 EXIF（`commands.py:341`） |
| `list` | `query*`（`cli.py:141-142`） | GUI 开 → `library.list`（`cli.py:181`）；否则 catalog 扫描（`cli.py:183-187`） | GUI：`{count, photos}`（`commands.py:230`）；headless：`{count, photos, source:'catalog'}` | ⚠️ headless 分支有**隐藏过滤** `if any(m.values())`（`cli.py:186`）——**只列出有评分/旗标/标签的相片**；宿主要全库列表必须用 `library.list` 命令 |
| `rate` / `flag` / `label` | `photos+` `value`（`cli.py:143-147`；`rate` 限 `0-5`，`flag`∈{pick,reject,none}，`label`∈6 色+none） | GUI → `library.<action>`（`cli.py:193`）；否则 `catalog.Catalog().set()`（`cli.py:195`） | GUI：`{changed, photos}`（`_rate` `commands.py:271`）；**headless：只有 `{changed}`** | ⚠️ **两种模式输出键不同**（`cli.py:195` 不产 `photos`）。宿主只读 `changed` 最安全 |
| `xmp read` / `xmp write` | `direction` `photos+`（`cli.py:148-150`） | **永远直连 catalog**，不看 GUI（`cli.py:196-203`） | read：`{changed}`（`cli.py:200`）；write：`{written:[sidecar...], errors}`（`cli.py:203`） | sidecar = `<name>.xmp`（`catalog.py:341-342`）；**写真永远不写原图**（`commands.py:301` summary） |
| `import-lightroom` | `catalog`（`cli.py:151-152`） | `library.import_lightroom`，**新建 headless Session**（`cli.py:205-206`） | `{imported, found, added}`（`commands.py:322`） | 只读 `.lrcat`（`commands.py:309-311`） |
| `commands` | 无（`cli.py:153`） | `commands.describe()`（`cli.py:208`） | `{commands:[{id, summary, read_only, tool, parameters}]}`（`commands.py:134-136`） | **宿主可运行时拉全量 schema 做自检/UI 生成** |
| `run` | `command` `args?(JSON, 默认 '{}')` `--headless`（`cli.py:154-157`） | `_context(args.headless)` → `context.run(cmd, payload)`，结果**并入 `mode` 键**（`cli.py:210-214`） | `{...command result..., mode:'gui'|'headless'}` | ⚠️ `args` 非 dict → `CommandError`（`cli.py:211-212`）；`_value` 容错：非 JSON 当字符串（`cli.py:56-60`） |
| `mcp` | `--headless`（`cli.py:158-159`） | `mcp.serve(args.headless)`（`cli.py:164-166`） | 协议报文走 stdout（见 §2） | stdin 关闭即退出，`serve` `return 0`（`mcp.py:203-209`） |
| `mcp-config` | `kind?` ∈{claude-code,codex,json}（`cli.py:160-161`） | `mcp_config()`（`cli.py:38-49`） | 纯文本/JSON，退出 0（`cli.py:167-169`） | 宿主可用来**反查自己该 spawn 的命令行**：`json` 模式给 `{command, args:[... 'mcp']}`（`cli.py:48-49`） |

### 1.3 `render` 的 `--set` 语义（B 通道调色入口）

`cli.py:100-111`：`KEY=VALUE`，`VALUE` 先试 `json.loads` 失败则当字符串（`cli.py:56-60`）；含 `.` 的键按层级建嵌套 dict
（`cli.py:105-109`，例 `hsl.blue.saturation=20`），否则落入 `changes['adjustments']`（`cli.py:104`）。
宿主若要把 UI 调色值传给 lumen：**拼 `changes` 对象走 `run edit.apply` 比拼 shell `--set` 更稳**（无引号/编码问题）。

---

## 2. `lumen/mcp.py` stdio 传输

### 2.1 成帧与读写

| 项 | 证据 | 契约 |
|---|---|---|
| 帧格式 + 写互斥 | `mcp.py:97` `json.dumps(msg, ensure_ascii=False, separators=(',',':')) + '\n'` → UTF-8 bytes；`mcp.py:98-100` `_write_lock` 包住 write+flush | **newline-delimited JSON-RPC 2.0，无长度头**。宿主按 `BufRead::read_line` + `serde_json::from_str` 解；服务端不会交插写坏帧，宿主同步请求无需额外处理 |
| 读循环 | `mcp.py:102-113` `for raw in stream`：空行跳过（:105），`json.loads` 失败 → `-32700` `id=null`（:109-111） | 宿主**不应**产生空行；收到 `-32700` 说明自己发坏了 |
| 批量 | `mcp.py:115-118` `handle_batch`：JSON array → 逐个 handle，滤掉 `None` | 宿主**不必**用 batch；若要省 RTT，可一次发 N 条 `tools/call` |
| 输出目标 | `mcp.py:90` `self.output or sys.stdout.buffer`；`mcp.py:205-207` `serve()` 先把 `protocol_out = sys.stdout.buffer`，再 `sys.stdout = sys.stderr` | **stdout 只承载协议**；宿主 spawn 时必须 `stdout(piped)` + `stderr(piped)` 且**永不把两者混流** |

### 2.2 协议方法与握手

| 方法 | 证据 | 应答 |
|---|---|---|
| `initialize` | `mcp.py:147-151` | `{protocolVersion, capabilities:{tools:{listChanged:false}}, serverInfo:{name,title,version}, instructions}`；`wanted` 不在 `LEGACY`（`mcp.py:25`）则回落 `LEGACY[0]='2025-11-25'`（:149） |
| `server/discover` | `mcp.py:152-154` | `{supportedVersions, capabilities, instructions, ttlMs:3600000, cacheScope:'private'}`（modern 专用） |
| `ping` | `mcp.py:155-156` | `{}` |
| `tools/list` | `mcp.py:157-159` | legacy：`{tools:[...]}`；modern：额外 `ttlMs/cacheScope` + `_meta.serverInfo`（`_modern` `mcp.py:170-172`） |
| `tools/call` | `mcp.py:160-162` | `{content:[...], structuredContent, isError}`（`mcp.py:194`） |
| `resources/list` `prompts/list` | `mcp.py:163-165` | `{resources:[]}` / `{prompts:[]}`（modern 加 ttl/cacheScope） |
| `resources/templates/list` | `mcp.py:166-167` | `{resourceTemplates:[]}`（modern 加 ttl/cacheScope） |
| 版本协商（modern） | `mcp.py:142-146` | `_meta['io.modelcontextprotocol/protocolVersion']` 不在 `VERSIONS`（`mcp.py:24-26`）→ `-32022` + `data{supported, requested}` |
| 未知方法 | `mcp.py:168` | `-32601 Method not found: <method>` |
| 非法请求 | `mcp.py:123-127` | 非 dict / `jsonrpc!='2.0'` / 无 `method` → `-32600`；但若是"我们从未发过的 response"（含 `result`/`error`）→ **静默忽略返回 None**（:124-125） |
| 通知 | `mcp.py:130-131` `id is None` → 不回复 | 宿主不要给 `tools/call` 省 id，否则拿不到结果 |
| 内部异常 | `mcp.py:136-138` | `-32603` + `f'{type(exc).__name__}: {exc}'` |

**宿主落地结论**：只走 `initialize`(protocolVersion=`"2024-11-05"`) → `tools/list` → `tools/call` 三条，永不带 `_meta`，
永远拿 legacy 裸信封，**零 modern 分支代码**。

### 2.3 Dispatcher 优先级（`mcp.py:58-84`）

```
run(command, args)                                     # mcp.py:72-84
 ├─ headless=False（默认）:
 │   ├─ control.Client(connect_timeout=.5) 成功 → client.call(...) 后 finally close   # mcp.py:74-82
 │   └─ control.Unavailable → 落到 headless                                        # mcp.py:77 → 83
 └─ headless=True（--headless）→ 直接 headless                                     # mcp.py:73
 headless 分支: with self._lock: commands.run(self.session(), ...)                 # mcp.py:83-84
 session 惰性创建并跨调用共享（Mutex 串行化）                                       # mcp.py:66-70
```

宿主含义：**同一份 `lumen-cli mcp` 进程，编辑器开不开行为不同**。宿主若想吃"GUI 内编辑可见/可 Ctrl+Z"，
就让 sidecar 不带 `--headless`；若要求可复现的批量输出，就带 `--headless` 固定语义。
⚠️ 编辑器开着时，MCP 每次调用都新建/关闭一条管道（`mcp.py:75-82`），**宿主自己的 C 通道连接与它互不干扰**。

### 2.4 工具表与 `tools/call` 结果结构

| 项 | 证据 | 契约 |
|---|---|---|
| 工具表生成 | `mcp.py:41-49` 遍历 `REGISTRY.values()`，`if not cmd.tool: continue`，按 `cmd.tool` 排序 | 名字 = `Command.tool`；`title` = 工具名下划线转空格 + capitalize（`mcp.py:46`）；`description` = `Command.summary`；`inputSchema` = `Command.schema()`（`commands.py:44-46`，`additionalProperties:false`）；`annotations` 由 `read_only` 推导（`mcp.py:48-49`） |
| `run_command` 逃生舱 | `mcp.py:50-54` | `inputSchema={command:string(required), args:object}`，**宿主可调任意 command id，包括 3 个无 tool 名的命令**（`library.read_xmp` / `library.write_xmp` / `library.import_lightroom`，`commands.py:294/303/311`） |
| 工具名→命令 id | `mcp.py:178` `next((c.id for c in REGISTRY.values() if c.tool == name), None)` | 未知工具 → `-32602 Unknown tool: <name>`（`mcp.py:180-181`） |
| 错误不抛异常 | `mcp.py:184-188` `CommandError`/任意 Exception → `{content:[{type:'text',text:...}], isError:true}` | **业务错误走 `isError`，不是 JSON-RPC error**。宿主必须同时检查 `error` 字段和 `result.isError` |
| 图片块 | `mcp.py:190-192` `command=='render.preview'` 且 `result['image']` → `content` 追加 `{type:'image', data, mimeType}`，并从 result 删 `image` | 宿主解析 `content[]` 找 `type=='image'`；`mimeType` 默认 `image/jpeg`（`commands.py:536`） |
| 文本块 | `mcp.py:193` 恒追加 `{type:'text', text: json.dumps(result)}` | **每个成功调用都有一段 JSON 文本**；宿主可以直接 `from_str(text)` 拿结构化结果，比 `structuredContent` 更省事 |
| `structuredContent` | `mcp.py:194` `= result`（已删 image） | 与 text 块同源；宿主二选一，别两处解析 |

---

## 3. `lumen/commands.py` REGISTRY：27 条命令 + 24 个工具名

注册机制：`@command(id, summary, params, required, read_only, tool)`（`commands.py:52-56`）→ `Command` dataclass（`commands.py:34-46`）。
`REGISTRY: dict[str, Command]`（`commands.py:49`）。**运行时全量清单**：`lumen-cli commands`（`cli.py:207-208` → `commands.py:134-136`）。

### 3.1 全量清单（按文件顺序）

| # | command id | 工具名（`tool`） | read_only | 参数（required 加粗） | 宿主分级 |
|---|---|---|---|---|---|
| 1 | `app.status` | `lumen_status` | ✅（`commands.py:196`） | 无 | **P0**（前置握手/模式探测） |
| 2 | `commands.list` | `list_commands` | ✅（:207） | 无 | P2（调试） |
| 3 | `library.list` | `list_photos` | ✅（:212） | `query:string`、`limit:int 1..5000`(默认500) | P1 |
| 4 | `library.add` | `add_photos` | ❌（:233） | **`paths:[]string`**、`recursive:bool` | P2 |
| 5 | `library.select` | `select_photos` | ❌（:254） | **`paths:[]string`** | P2 |
| 6 | `library.rate` | `rate_photos` | ❌（:274） | **`rating:int 0..5`**、`paths:[]string` | **P0** |
| 7 | `library.flag` | `flag_photos` | ❌（:280） | **`flag:enum[pick,reject,none]`**、`paths` | **P0** |
| 8 | `library.label` | `label_photos` | ❌（:286） | **`label:enum[red,yellow,green,blue,purple,none]`**、`paths` | **P0** |
| 9 | `library.read_xmp` | —（无 tool，`commands.py:294`） | ❌ | `paths` | P1（走 `run_command`） |
| 10 | `library.write_xmp` | —（`commands.py:303`） | ❌ | `paths` | P1（走 `run_command`） |
| 11 | `library.import_lightroom` | —（`commands.py:311`） | ❌ | **`catalog:string`**、`add:bool` | P2 |
| 12 | `photo.open` | `open_photo` | ❌（:327） | **`path:string`** | **P0**（预览前置） |
| 13 | `photo.info` | `photo_info` | ✅（:346） | `path:string` | P2（宿主已有 EXIF） |
| 14 | `edit.get` | `get_edits` | ✅（:354） | `path:string`、`full:bool` | **P0**（读 recipe） |
| 15 | `edit.apply` | `apply_edits` | ❌（:398） | **`changes:object`**、`path`、`reset:bool`、`amount:number 0..150`(默认100)、`label:string` | **P0/P1**（写 recipe） |
| 16 | `edit.reset` | `reset_edits` | ❌（:418） | `path` | P2 |
| 17 | `edit.undo` | `undo` | ❌（:431） | `path` | P2 |
| 18 | `edit.redo` | `redo` | ❌（:436） | `path` | P2 |
| 19 | `edit.auto` | `auto_tone` | ❌（:442） | `path` | P2 |
| 20 | `edit.presets` | `list_presets` | ✅（:453） | 无 | P2 |
| 21 | `edit.preset` | `apply_preset` | ❌（:458） | **`name:string`**、`amount:number 0..100`、`path` | P2 |
| 22 | `edit.copy` | `copy_edits` | ❌（:472） | **`to:[]string`**、`path` | P1（批量同步色调） |
| 23 | `edit.process` | `set_process_version` | ❌（:495） | **`version:enum[1,2]`**、`path` | P2 |
| 24 | `render.preview` | `render_preview` | ✅（:524） | `path`、`size:int 128..2048`(默认1024)、`original:bool`、`output:string` | **P0**（主循环心脏） |
| 25 | `photo.export` | `export_photo` | ❌（:543） | **`output:string`**、`path`、`quality:int 50..100`、`long_edge:int 16..20000`、`overwrite:bool` | P1（B 通道重活） |
| 26 | `photo.export_batch` | `export_photos` | ❌（:577） | **`folder:string`**、`paths`、`query:string`、`format:enum[jpg,png,tif,dng]`、`quality 50..100`、`long_edge 16..20000` | P1 |
| 27 | `project.save` | `save_project` | ❌（:601） | `path`、`output:string` | **P1**（持久化编辑，宿主编辑态的落地） |

> 计数：27 条命令；其中 24 条有 `tool` 名（#9/#10/#11 无）→ `tools()` 产 24 + `run_command` = **25 个工具**（`mcp.py:41-55`）。

### 3.2 P0/P1 关键命令完整 schema 与返回值

**`render.preview`（`commands.py:524-537`）— 宿主主循环唯一必需的渲染入口**

```
参数：path（省略=当前图）、size（长边 128..2048，默认 1024）、original（未编辑原图）、output（同时落盘）
返回：{path, width, height, mime:'image/jpeg', image:<base64 jpeg>, statistics, output}
管线：preview_image（commands.py:507-514）→ engine.crop_rotate(engine.process(...), apply_crop=False)
      → engine.resize_limit(rgb, size) → jpeg(rgb)（commands.py:517-521，PIL quality=88 硬编码）
旁路：_target（commands.py:150-158）会自动 open 不匹配的 path
```

宿主注意：① `image` 是 base64（`commands.py:536`）；② **不要对结果做方向校正**（B 领域已论证，输出已 upright）；
③ `output` 存在时同时写文件（`commands.py:533-534`）——**B 通道首选，绕开 base64**；
④ `statistics` 来自 `nl_edit.image_statistics`（`commands.py:535`），可替代宿主 canvas 直方图（见 F 领域）。

**`edit.get`（`commands.py:354-364`）**

```
参数：path、full（true 时附完整 recipe）
返回（full=false）：{path, process, state, changes}          ← _summary（commands.py:185-187）
返回（full=true） ：外加 recipe（去掉 masks 的 raster/strokes，含 masks 摘要）（commands.py:362-363）
契约：changes = nl_edit.changes(_fresh(edits), edits)（commands.py:186-187）
      _fresh（commands.py:177-182）= model.recipe() + 继承 white_balance/develop/lens/process
      → "相对相机初始值的差异"，正是宿主 UI 需要的"用户改了什么"
```

**`edit.apply`（`commands.py:398-415`）**

```
参数：changes（CHANGES schema，commands.py:367-376：adjustments/hsl/grading/effects/monochrome/curve/masks）、
      path、reset（先重置全局 look）、amount（0..150，强度百分比）、label（编辑器里显示的撤销步骤名）
返回：{path, applied:[...描述行...], notes:[...], state}
语义：changes 是"最终值"不是增量（commands.py:368）；经 nl_edit.plan → _regions（AI 区域，commands.py:379-395）
      → nl_edit.blend(amount/100) → model.validate → context.apply(path, target, label)
      → GUI 模式下 = 一个可 Ctrl+Z 的撤销步（control.py:239-260）
错误：nl_edit.ServiceError → CommandError（commands.py:407-409）
```

**`library.rate/flag/label`（`commands.py:274-290` + `_rate` `commands.py:265-271`）**

```
共同参数：<field>（必填）+ paths（省略 → _targets：selection → current → 报错，commands.py:165-174）
返回：{changed:[...], photos:[{path,name,rating,flag,label,current,selected}]}   ← commands.py:271 / _meta 190-191
校验：catalog.validate（catalog.py:84-108）：rating 必须整数 0..5；'none'/'unflagged' 归一为 ''
持久化：catalog.set → catalog.jsonl 追加写 + fsync（catalog.py:221-251）
      write_xmp_on_change 为真时顺带写 sidecar（catalog.py:249-250，受 setting library_xmp 控制，catalog.py:52-55）
```

**`library.read_xmp` / `library.write_xmp`（`commands.py:293-306`）— 无 tool，只能 `run_command`**

```
read_xmp ：paths → catalog.read_xmp(targets) → catalog.merge(values, overwrite=True) → {changed}
write_xmp：paths → {written:[<name>.xmp...], errors}（commands.py:305-306）
宿主用途：与宿主已有 XMP 逻辑（src-tauri/src/xmp.rs）互通——两边都写真不改原图
```

**`project.save`（`commands.py:601-608`）**

```
参数：path、output（省略 → 同目录同名 .lumen，commands.py:605）
返回：{path, project:<保存路径>}(commands.py:608 → Context.save_project)
副作用：GUI 模式还会更新窗口 project_path/saved_edits/state_label（control.py:285-301）
      headless 模式 → model.save_project + document['project']（session.py:136-139）
宿主价值：这是"宿主编辑态 ↔ lumen 工程"的唯一正式桥梁；缓存 key 必须纳入 .lumen mtime（见 B 领域）
```

### 3.3 通用参数校验（宿主要防的第一类错误）

| 规则 | 证据 | 宿主动作 |
|---|---|---|
| 未知键直接报错 | `arguments()` `commands.py:116-118` `unknown argument(s) for <id>` | **不要多传键**；`additionalProperties:false`（`commands.py:44-46`） |
| 缺必填报错 | `commands.py:119-121` | 宿主用 serde `#[serde(default)]` 会踩坑：缺的键不会自动补，直接 CommandError |
| 类型严格 | `_check` `commands.py:87-108`：bool 不算 integer（:93）；`1.0` 可转 int（:95-96）；非有限数报错（:101-103）；越界报错（:104-105） | 宿主 serde 侧用 `i64`/`f64` 精确对应，别用 `serde_json::Value` 透传浮点 |
| 路径归一 | `_resolve` `commands.py:146-147` `Path().expanduser().resolve()` | 宿主传绝对路径；大小写在 Windows 由 `catalog.key` 处理（`catalog.py:75-78` normcase） |

---

## 4. `lumen/control.py` 命名管道协议（C 通道）

### 4.1 端点与开关

| 项 | 证据 | 值 / 契约 |
|---|---|---|
| 管道名 | `channel_name()` `control.py:34-39` | `lumen-raw-control-<user>`，`<user>` = `getpass.getuser()`，非 `[A-Za-z0-9_.-]` 替换为 `_` |
| 环境变量覆盖 | `control.py:35-37` | `LUMEN_CONTROL_NAME`（测试用）。**宿主生产环境不要设**，否则连不上真编辑器 |
| Windows 端点 | `_endpoint()` `control.py:46-49` | `\\.\pipe\lumen-raw-control-<user>` |
| 非 Windows | `control.py:49` | `$TMPDIR/lumen-raw-control-<user>`（Unix socket） |
| 开关 | `enabled()` `control.py:42-43` | setting `agent_control`，**默认 '1'（开）**。宿主可假设默认可用 |
| 服务端 | `Server` `control.py:313-333` + `start()` `control.py:339-348` | `QLocalServer` + `UserAccessOption`（`control.py:324`，仅同用户）；stale socket 会 removeServer 重试（`control.py:343-344`） |
| 可用性探测 | `available()` `control.py:114-119` | 连上即关，返 bool。宿主应对应一个廉价的 `probe()` |

### 4.2 帧格式（精确到字段）

**请求**（`Client.call` `control.py:96-98`）：

```json
{"id": 1, "command": "render.preview", "args": {"path": "D:\\x.DNG", "size": 1600}}
```

- `id`：客户端自增整数（`control.py:63,97` `self._ids += 1`）
- `command`：命令 id 字符串（`commands.REGISTRY` 的 key）
- `args`：dict，**绝不省略**（`args or {}`，`control.py:98`）
- 分隔：单 `\n`，UTF-8（`control.py:98`）

**应答**（`Server.handle` `control.py:401-413` + `_write` `control.py:415-419`）：

```json
{"id": 1, "ok": true,  "result": {...}}
{"id": 1, "ok": false, "error": "file not found: D:\\x.DNG"}
```

- `ok` 恒存在；成功必有 `result`（可能是 `{}`），失败必有 `error`（字符串，**不是对象**）
- 写回时追加 `\n`（`control.py:418`）
- 客户端把 `ok=false` 转成 `commands.CommandError(reply['error'] or 'command failed')`（`control.py:103-104`）

### 4.3 并发与超时模型（宿主最需要抄/最需要补的部分）

| 机制 | 证据 | 行为 |
|---|---|---|
| 服务端串行队列 | `Server._work` 单线程 worker（`control.py:330-333, 382-386`） | 命令**一个接一个**执行；GUI 相关部分经 `Bridge.call` 抛到 GUI 线程（`control.py:132-158`） |
| GUI 线程桥超时 | `Bridge.call(timeout=300)` `control.py:149-155` | GUI 线程无响应 → `CommandError('the editor did not respond in time')` |
| `photo.open` 双重截止 | `WindowContext.open` `control.py:201-222` | 等空闲 30s（:207-211）；等加载完成 300s（:213-222）；忙 → `'the editor is busy; try again'` |
| **客户端无读超时** | `Client._receive` `control.py:90-94` | 裸 `pipe.read(65536)`，**无限阻塞**。宿主必须自建 |
| **无 id 校验** | `Client.call` `control.py:99-105` | 只找下一个 `\n` 就 `json.loads`，**不比对应答 id**。→ 一条连接同时只能有一个 in-flight 请求 |
| 每调用新建连接 | `mcp.py:75-82`（`finally: client.close()`）、`cli.py:68-75` | 官方参考实现就是"连-发-读-关"。宿主照此最安全 |
| 连接重试 | `Client.__init__` `control.py:66-82` | `FileNotFoundError` → 直接 `Unavailable`；其他 OSError（含 Windows 231 管道忙）→ 0.05s 轮询到 `connect_timeout`（默认 1s） |
| 缓冲区上限 | `Server._read` `control.py:368-376` | 单连接无 `\n` 数据超 64MiB 直接丢弃（`control.py:374-375`） |
| 关闭清理 | `_closed` `control.py:364-366` | 断开即删 buffer；`Client.close` 容错 OSError（`control.py:107-111`） |

### 4.4 C 通道对宿主的真实价值与风险

| 价值 | 风险 / 缓解 |
|---|---|
| 用户能**看见** agent 的每次编辑并可 Ctrl+Z（`control.py:239-260`、模块 docstring `control.py:6-7`） | 需要编辑器在跑；`available()` 为假就跌落到 A/B（`mcp.py:73-84` 同逻辑） |
| 绕过 RAW 解码成本：图片已在编辑器内存（`WindowContext.source` 优先返回 `w.source`，`control.py:274-283`） | GUI 线程被用户操作占住 → 300s 上限（`control.py:149`）。宿主 UI 必须显示"等待编辑器"态 |
| 每条命令一个撤销步（`control.py:239-260`） | `library.*`/`render.*` 仍在 worker 线程跑（非 GUI），不阻塞界面 |
| 无 tool 名的 3 条命令同样可达（`control.py:406` 直接 `commands.run`） | 主机若只实现 MCP 客户端，这 3 条必须走 `run_command`（`mcp.py:50-54`） |

---

## 5. 宿主侧现状：命令注册 / 错误处理 / subprocess 先例 / invoke 封装

### 5.1 命令注册风格（`src-tauri/src/lib.rs` + `commands.rs`）

| 模式 | 证据 | 新桥接命令要遵守的写法 |
|---|---|---|
| 模块声明 | `lib.rs:1-7` `mod commands; mod db; mod luminar; mod models; mod scanner; mod thumbnail; mod xmp;` | 新增 `mod lumen;`（桥接层） |
| 集中注册 | `lib.rs:23-38` `tauri::generate_handler![...]` 15 个命令，snake_case + `_cmd` 后缀 | 新命令同样追加进这个数组，例 `lumen_preview_cmd` |
| State 依赖注入 + 用法 | `commands.rs:12-14` `pub struct AppState { pub db: Database }`；`lib.rs:22` `.manage(AppState { db })`；`commands.rs:222-233` `state.db.load_settings()` / `save_settings(&settings)?` | 桥接需要 `State<'_, LumenState>`，**新建一个 `LumenState`**，不要塞进 `AppState`（避免 db 生命周期耦合）；用法 `state.lumen.<method>()?`，错误 `?` 直接透传 |
| 命令签名 | `commands.rs:16-21` `#[tauri::command] pub async fn scan_folders_cmd(jpg_folder: String, sort_order: Option<String>) -> Result<FolderScanResult, String>`；纯内存读的命令可不加 `async`（`commands.rs:222` `pub fn get_settings_cmd`） | 一律 `pub async fn x_cmd(...) -> Result<T, String>`；入参标量/`Option`。桥接的"纯内存读"（如 `lumen_status_cmd`）同样可不加 `async` |

### 5.2 错误处理风格（宿主强约定：中文前缀 + `format!`）

| 证据 | 原文 | 桥接层要复用的句式 |
|---|---|---|
| `commands.rs:25` | `.map_err(\|e\| format!("扫描任务异常: {}", e))?` | spawn_blocking 的 join 错误要包中文前缀 |
| `commands.rs:36` | `format!("生成缩略图任务异常: {}", e)` | 同上 |
| `luminar.rs:64` | `.ok_or_else(\|\| "未检测到 Luminar AI，请确认计算机上已安装 Luminar AI。".to_string())?` | lumen-cli 找不到时的同款提示 |
| `luminar.rs:131` / `:159` | `format!("启动 Luminar AI 进程失败: {}", e)` / `format!("Luminar 执行任务异常: {}", e)` | spawn 失败 / join 错误 |

**要点**：宿主错误一律 `String`（不是 `anyhow`/`thiserror`），消息**面向用户**且中文。exit≠0 的模板照抄 `luminar.rs:136-138`
`format!("Luminar AI 进程非正常退出 (Exit Code: {:?})", status.code())`；产物缺失照抄 `luminar.rs:143`。
桥接层内部可用 `Result<_, BridgeError>` 自建枚举，但在 `#[tauri::command]` 边界 `map_err(\|e\| e.to_string())` 或 `format!` 成中文句子。

### 5.3 `luminar.rs` subprocess 先例（桥接 B 通道的骨架）

`edit_in_luminar`（`luminar.rs:62-160`）的完整流程，逐段对照：

| 步骤 | 行号 | 做法 | B 通道对应改造 |
|---|---|---|---|
| ① 可执行文件定位 | `luminar.rs:6-59` | Windows 注册表 `reg query HKLM\...\ApplicationPath` → HKCU → 硬编码默认路径 `C:\Program Files\Skylum\...` | **改成 lumen-cli 定位**：设置项 `lumen_cli_path` → `%LOCALAPPDATA%\Programs\lumen-raw\lumen-cli.exe` → PATH 查找 → 源码树 `<exe> main.py --cli`（对应 `cli.py:28-35` `executable()` 的两种模式） |
| ② 输入校验 | `luminar.rs:66-68` `if !file_path.exists()` | 同款：`Path::new(&p).exists()` |
| ③ 目标文件准备 + 记 mtime | `luminar.rs:112` `fs::metadata(&target_tif).and_then(\|m\| m.modified()).ok()` | B 通道 `output=` 落盘后同样**比对 mtime** 防"没写成功" |
| ④ 参数拼装 | `luminar.rs:116-125` `Command::new(&exe).arg(...).arg(...)`（Photoshop 插件协议） | B 通道：`.arg("run").arg(command_id).arg(json_args).arg("--headless")`（`cli.py:154-157`） |
| ⑤ spawn 到阻塞线程 | `luminar.rs:129-133` `tokio::task::spawn_blocking(move \|\| cmd.status())` | **完全照抄**：stdio 阻塞读必须 `spawn_blocking`，不能占 async runtime |
| ⑥ exit code 检查 | `luminar.rs:134-139` | 同款，但 exit **1 = lumen 业务错误（stderr 有 `lumen-cli: ...`）**、**2 = 用法错误**，消息要区分 |
| ⑦ 产物存在性 | `luminar.rs:142-144` | 同款：`output` 文件必须存在 |
| ⑧ mtime 变化验证 | `luminar.rs:147-153` | 同款；注意 `luminar.rs:155-156` 最终"存在即成功"的宽松兜底**不要照抄**——lumen 的 `output` 语义更明确，应以存在 + mtime 变化为准 |
| ⑨ A 通道（常驻）**无先例** | — | `luminar.rs` 是"启动-等待-退出"型；**A 通道需要长生命周期 + 读写双线程**，宿主今天完全没有对应代码，见 §6 |

### 5.4 `api.ts` invoke 封装（`src/services/api.ts`）

| 模式 | 证据 |
|---|---|
| 统一入口对象 | `api.ts:5` `export const api = { ... }`，每个方法一条 JSDoc（`api.ts:6-8` 等） |
| 调用形态 | `api.ts:14-18` `invoke<FolderScanResult>('scan_folders_cmd', { jpgFolder, rawFolder: rawFolder \|\| null, sortOrder: sortOrder \|\| null })` — **camelCase 键 + `\|\| null` 规约** |
| Option 传参 | `api.ts:26-28` `width: width \|\| 200`；`api.ts:57` `customPsPath: customPsPath \|\| null` |
| 文件 URL 转换 | `api.ts:29` `convertFileSrc(localCachePath)`；`api.ts:194-196` `toAssetUrl` — **lumen 预览落盘后必须走这个**才能被 `<img>` 用 |
| 文件对话框 | `api.ts:181-189` `open({directory:true, ...})` |
| 类型来源 | `api.ts:3` `from '../types'` — 新桥接类型要加进 `src/types/index.ts` |

宿主要新增的封装（命名参照现有风格）：`getLumenPreview(path, opts)` / `getLumenEdits(path)` / `applyLumenEdits(path, changes)` /
`lumenStatus()` / `setLumenRating(paths, rating)` / `lumenRoundtrip(path)`；统一在 Rust 侧返回**本地文件路径**，TS 侧 `convertFileSrc`。

### 5.5 依赖现状（桥接可行性）

| 依赖 | 证据 | 够不够 |
|---|---|---|
| `serde_json` | `Cargo.toml:28` | ✅ JSON-RPC 编解码够用 |
| `tokio` features + `std::process` | `Cargo.toml:39` `features = ["rt"]`；`luminar.rs:3`、`commands.rs:3` 已有 `std::process::Command` | ⚠️ tokio **只有 rt**。A 通道要 async 管道需补 `"process"`/`"io-util"`/`"sync"`(mpsc)/`"time"`(超时)；若坚持 `std::process` + `std::sync::mpsc` 则只需 `"sync"`。**建议后者**：与 `luminar.rs:129` 的 `spawn_blocking` 风格一致且无 async 管道生命周期难题。B 通道零新依赖 |
| Windows 命名管道 | — | ❌ 宿主无任何管道代码；std 无命名管道支持。C 通道需 `named-pipe` crate 或 `windows-sys` `CreateFileW` |
| `base64` | — | ❌ 未引入。**这是"推荐 B 通道 `output=` 落盘"的硬理由**：避免了为预览图引 base64 依赖 |
| sidecar 机制 | `tauri.conf.json:40-51` `bundle` 无 `externalBin`/`resources` | ⚠️ 打包侧（D 领域）需补；本文只记桥接需求：宿主要能**稳定拿到 lumen-cli.exe 路径** |

---

## 6. Gap 表：lumen 提供 ↔ 宿主需要

图例：🔴 必须补（P0 阻塞）/ 🟡 应补（P1）/ 🟢 可选（P2）

### 6.1 传输与生命周期

| # | Gap | lumen 侧现状（证据） | 宿主侧现状 | 严重度 | 补齐方案 |
|---|---|---|---|---|---|
| G1 | **请求 id 多路复用** | `Client.call` 递增 `self._ids` 但**从不校验应答 id**（`control.py:96-105`）；官方用法是每次新建连接（`mcp.py:75-82`） | 无 | 🔴 | 两选一：①（推荐，零风险）**一条连接同一时刻一个 in-flight 请求**，`Mutex<Client>` 串行化，完全对齐 lumen 语义；② 真并发：连接池（N 条管道），每条仍严格 request→reply。**绝不在单连接上并发** |
| G2 | **读超时** | `Client._receive` 裸阻塞（`control.py:90-94`），无任何 socket/pipe timeout | 无 | 🔴 | B 通道：`spawn_blocking` + `child.wait_timeout`（需 `wait-timeout` crate）或 `std::process` 无超时 → 用独立看门狗线程 `recv_timeout`。A 通道：读线程 + `mpsc::Receiver::recv_timeout(Duration)`；超时判进程失联 |
| G3 | **崩溃重启 / 资源回收** | `serve()` 在 stdin EOF 后正常退出（`mcp.py:102-104, 203-209`）；编辑器崩了管道自然断开（`control.py:93` `raise ConnectionError`）；MCP 进程持有一个惰性 headless `Session`（`mcp.py:66-70`） | 无（`luminar.rs` 是一次性 spawn，从不重启） | 🔴 | `LumenState` 内建 supervisor：监听子进程退出/stdin EOF → 指数退避重启（0.5s→1s→2s→上限 8s，最多 N 次）→ 重启后**重跑 initialize + tools/list**；重启期间命令返回 `"LUMEN RAW 编辑器未就绪，正在重连…"`。空闲 N 分钟无调用可主动关进程回收内存，下次再拉起（`app.status` `commands.py:196-204` 做健康探针） |
| G4 | **版本握手断言** | `initialize` 返 `serverInfo.version`（`mcp.py:150-151`、`SERVER` `mcp.py:28`）；`app.status` 返 `version`（`commands.py:200`） | 无 | 🔴 | 启动时断言 `version == "1.6.0"`（钉死 `43b4ebe`）；不符 → 把 RAW 链路整体降级为"仅 JPG 模式"并在设置页提示升级；`lumen-cli --version`（`cli.py:126`）作为 B 通道预检的便宜替代 |
| G5 | **协议版本协商** | 双时代：`initialize`（`mcp.py:147-151`）/ `server/discover` + 每请求 `_meta`（`mcp.py:142-146`），不支持报 `-32022` | 无 | 🟡 | 宿主**只实现 legacy 客户端**：发一次 `initialize{protocolVersion:"2024-11-05"}`，之后永不带 `_meta` → 永远走裸信封（`mcp.py:157-162`） |
| G6 | **stderr / 日志隔离** | `mcp.py:205-207` `sys.stdout = sys.stderr` 保证库打印不污染协议；`cli.py:123-124` CLI 日志落文件 | 无 | 🔴 | spawn 时 `stdout(piped)` + `stderr(piped)` **两者分开**；读线程各自独立；stderr 收集进环形缓冲供 `lumen_logs_cmd` 排查 |
| G7 | **可执行文件定位** | `cli.py:28-35` `executable()`：frozen →  exe 同级 `lumen-cli.exe`；源码 → `[sys.executable, main.py, '--cli']` | 只有 Luminar 的注册表查找（`luminar.rs:6-59`） | 🔴 | 新写 `find_lumen_cli()`：① 设置项显式路径 → ② `%LOCALAPPDATA%\Programs\LUMEN RAW\lumen-cli.exe` → ③ `%PROGRAMFILES%\LUMEN RAW\lumen-cli.exe` → ④ `where lumen-cli`（`commands.rs:118-121` 同款 `Command::new("cmd")` 风格）→ ⑤ 源码树回退。全程仿 `find_luminar_executable` 的"逐级降级 + `p.exists()` 校验" |
| G8 | **进程常驻的资源占用** | MCP 进程持有一个 headless `Session`（惰性，`mcp.py:66-70`） | 无 | 🟢 | UI 空闲 N 分钟无调用 → 主动关 sidecar（类似回收）；下次调用再拉起。`app.status`（`commands.py:196-204`）做健康探针 |

### 6.2 数据契约


| # | Gap | lumen 侧现状（证据） | 宿主侧现状 | 严重度 | 补齐方案 |
|---|---|---|---|---|---|
| G9 | **base64 图片过管道** | `render.preview` 返 `image` base64（`commands.py:536`）；MCP 转 image block 并从 result 删键（`mcp.py:190-192`）；CLI `run` 也剥键（`cli.py:218-219`） | 宿主无 base64 crate（`Cargo.toml:22-40`） | 🔴 | **统一走 `output=` 落盘**：A 通道调 `render_preview{path,size,output}` → 从 `structuredContent`/text 块读 `output` 路径 → `convertFileSrc`；B 通道 `run render.preview` 同理。**不引 base64 依赖**。仅当需要内存直传（拖动对比）时才引 `base64` crate |
| G10 | **`isError` vs JSON-RPC `error` 双通道** | 业务错 → `{content, isError:true}`（`mcp.py:184-188`）；协议错 → `error`（`mcp.py:134-138`） | 无 | 🔴 | 宿主 `tools/call` 解析必须**先看 `error` 再看 `result.isError`**，两者都映射为 `Err(String)`；`content[].text` 里正是 `str(exc)`（`mcp.py:185`）可直接透出给用户 |
| G11 | **两种模式下 `list`/`rate` 输出键不同** | GUI `{count,photos}` vs headless `{count,photos,source}`（`cli.py:181-187`）；rate GUI `{changed,photos}` vs headless `{changed}`（`cli.py:193-195`） | 无 | 🟡 | 宿主只依赖 `changed` / `photos[].path` 这类**公共子集**；`source` 与 headless 的 `any(m.values())` 过滤（`cli.py:186`）不要出现在宿主 UI 逻辑里 |
| G12 | **`library.read_xmp`/`write_xmp`/`import_lightroom` 无 tool 名** | `commands.py:294/303/311` 未设 `tool` → `mcp.py:43-45` 被跳过 | 无 | 🟡 | 走 `run_command{command:"library.write_xmp", args:{paths}}`（`mcp.py:50-54`）；**注意宿主 XMP 写入口已有自己的实现**（`xmp.rs`），P0 不必接 |
| G13 | **`edit.get` 的 `changes` 是"相对差"不是绝对值** | `_summary`/`_fresh`（`commands.py:177-187`）对比 `model.recipe()` 基线 | 宿主 `ToneAdjustments` 是绝对值（`models.rs:35-44`） | 🟡 | 宿主 UI 显示 lumen 的 `changes` 即可（本就是"用户改了什么"）；若要写回，用 `edit.apply{changes}` 传**最终值**（`commands.py:368`），不要把 `changes` 当增量二次套用 |
| G14 | **`messages` 里没有"宿主选片状态"** | `Session` 每进程全新（`session.py:24-32`）；GUI 的 selection 来自 filmstrip（`control.py:182-192`） | 宿主有自己的 `FolderScanResult`/session（`commands.rs:235-255`） | 🟡 | **宿主保持自己的选片状态为唯一真相**；每次调 lumen 都显式传 `paths`/`path`，绝不依赖 `_targets` 的 fallback（`commands.py:165-174`） |
| G15 | **会话粘性（谁持有 current photo）** | headless 下 `_target` 遇不匹配会自动 `context.open(path)`（`commands.py:150-158`）→ 隐式切换当前图 | 无 | 🟢 | 无害但要知道：A 通道的 sidecar 里 current photo 会漂移。若担心，B 通道每次显式带 `path`（自包含），A 通道可接受漂移 |

### 6.3 宿主侧结构

| # | Gap | 严重度 | 补齐方案 |
|---|---|---|---|
| G16 | 无常驻进程管理先例 | 🔴 | 新建 `src-tauri/src/lumen.rs`，内含 `LumenState(Mutex<Bridge>)` + `struct Bridge { child, stdin, stdout, next_id, tools, version }`；仿 `luminar.rs` 的函数式风格但加 `Mutex`。`lib.rs` 加 `mod lumen;` + `.manage(LumenState::new())`（仿 `lib.rs:22`） |
| G17 | `tokio` features 不足 | 🔴 | `Cargo.toml:39` 补 `["rt","process","io-util","sync","time"]`；若走纯 std + `spawn_blocking` + 读线程，则最少补 `"sync"`。**建议后者**：与 `luminar.rs:129` 的 `spawn_blocking` 风格一致，且不引 async 管道生命周期难题 |
| G18 | C 通道无管道能力 | 🟢 | P2 再做：`named-pipe` crate（Win）或直接用 `\\.\pipe\` + `CreateFileW`。若做，必须实现"读超时 + 连接级串行"（G1/G2），并处理 `control.py:78-82` 的 231 重试语义 |
| G19 | 无健康检查/降级路径 | 🔴 | `lumen_status_cmd`（→ `app.status`，`commands.py:196-204`）返回 `{available, mode, version, error}`；UI 据此决定显示"RAW 编辑可用/不可用"。错误文案句式仿 `luminar.rs:64` |
| G20 | 前端无类型 | 🟡 | `src/types/index.ts` 加 `LumenStatus`/`LumenPreviewResult`/`LumenEdits`/`LumenChanges`；`api.ts` 加 §5.4 那组方法 |

---

## 7. step-by-step 落地步骤（每步可独立验证）

> 顺序即依赖顺序。每步给"动作 + 验收标准"，**不做完一步不进下一步**。全程两仓库只读，宿主改动在宿主仓库。

### 阶段 0 — 只读勘察（不动代码）

**步 0.1 摸清 lumen-cli 三种形态**
- 动作：确认目标机器上 `lumen-cli.exe` 是否存在；`lumen-cli --version` 期望输出 `LUMEN RAW 1.6.0`（`cli.py:126`）。
- 验收：得到确定的 exe 绝对路径 或 确认需随包分发；版本串精确等于 `1.6.0`。
- 附加：跑 `lumen-cli mcp-config json`（`cli.py:38-49`），记录它输出的 `command`/`args` —— 这就是宿主 spawn 参数的**黄金参照**。

**步 0.2 冻结命令清单**
- 动作：对一张测试 RAW 跑 `lumen-cli commands > commands.json`（`cli.py:207-208`）。
- 验收：JSON 含 27 条命令、24 个 `tool` 名、3 条 tool 为 null；逐条与 §3.1 表比对**零差异**。有差异先停下来更新契约，不要带病往下写。

### 阶段 1 — B 通道（`lumen-cli run` 单发，零新依赖，先跑通价值）

**步 1.1 `find_lumen_cli()`**
- 动作：在宿主新增函数，仿 `luminar.rs:6-59` 的逐级降级结构做 §6.1-G7 的五级查找。
- 验收：单元测试 5 个 case（显式路径 / LOCALAPPDATA / Program Files / PATH / 全失败）各返回预期；全失败时错误文案中文且含"未检测到"。

**步 1.2 `lumen run` 薄封装 + 错误映射**
- 动作：`fn run_lumen(command: &str, args: serde_json::Value) -> Result<serde_json::Value, String>`，内部 `Command::new(&exe).args(["run", command, &args.to_string(), "--headless"])`（`cli.py:154-157`），`spawn_blocking` 包 `output()`。
- 验收：exit 0 → `serde_json::from_slice(&stdout)` 成功（`stdout` 以 `{` 开头，`cli.py:53` 的美化缩进不影响整段解析）；exit 1 → 错误串以 `lumen-cli: ` 内容为主体（`cli.py:216`）并包中文前缀；exit 2 → 明确报"参数错误（宿主 bug）"。

**步 1.3 `render.preview` 落盘链路（价值闭环）**
- 动作：`lumen_preview_cmd(path, size, original)` → 内部 `run_lumen("render.preview", {"path":..,"size":..,"output":"<app_cache>/lumen/<sha>.jpg"})`（`commands.py:524-537`），返回**本地文件路径**。
- 验收：① 返回路径存在且是合法 JPEG；② mtime 晚于调用前（防"没写"），仿 `luminar.rs:147-153`；③ 同一 path+size+同一 `.lumen` mtime 的第二次调用命中缓存（不重跑进程）；④ 缓存 key 含 `sha2`（`Cargo.toml:35` 已有 `sha2`）与 lumen 版本号。
- 注意：`output` 目录要先 `create_dir_all`（仿 `commands.rs:170-171`）。

**步 1.4 评级/旗标/标签写回**
- 动作：`lumen_rate_cmd(paths, rating/flag/label)` → `run_lumen("library.rate", {...})`（`commands.py:274-290`）。
- 验收：跑一次后 `catalog.jsonl` 尾部新增 N 行（`catalog.py:181-194`）；二次同值调用返回 `changed: []`（`catalog.py:239-241` 幂等）。
- 注意：只依赖 `changed` 键，不读 `photos`（§6.2-G11）。

**步 1.5 前端接通**
- 动作：`api.ts` 加 `getLumenPreview` / `setLumenRating`，用 `convertFileSrc`（`api.ts:29`）。
- 验收：UI 上能看到 RAW 的 lumen 预览图；打分后面板刷新且重启应用后 rating 仍在（catalog.jsonl 持久化，`catalog.py:1-9` docstring）。

### 阶段 2 — A 通道（`lumen-cli mcp` 常驻，主循环）

**步 2.1 `LumenState` 与 supervisor 骨架**
- 动作：`src-tauri/src/lumen.rs`：`Mutex<Bridge>`，`Bridge::spawn()` 起 `lumen-cli mcp`（**不加 `--headless`**，`cli.py:158-159`），`stdin(Stdio::piped())` / `stdout(Stdio::piped())` / `stderr(Stdio::piped())`；起读线程（stdout 行 → `mpsc::Sender<String>`）与 stderr 收集线程。
- 验收：① 能起进程；② 读线程收到 `initialize` 应答；③ 关掉 stdin 后子进程在 1s 内自行退出（`mcp.py:102-104`）——**这是"能干净回收"的证明**。

**步 2.2 JSON-RPC 客户端（legacy only）**
- 动作：`fn request(method, params) -> Result<Value, String>`：写 `{"jsonrpc":"2.0","id":n,"method":..,"params":..}\n` 到 stdin，flush；从 mpsc 通道 `recv_timeout` 读一行 `from_str`；校验 `id` 匹配（**宿主自己严格校验**，不像 `control.py:99-105`）。
- 验收：① `initialize` 返 `serverInfo.name=="lumen-raw"` 且 `version=="1.6.0"`（断言 G4，不符即报中文错误并禁用 RAW 链路）；② `ping` 返 `{}`（`mcp.py:155-156`）；③ 发一个坏 JSON，收到 `-32700`（`mcp.py:110`）；④ 发未知 method 收到 `-32601`（`mcp.py:168`）。

**步 2.3 工具表缓存 + `tools/call`**
- 动作：握手后 `tools/list`（`mcp.py:157-159`）缓存进 `Bridge.tools`；`call_tool(name, args)` 发送 `tools/call`；解析顺序：`error` → `result.isError` → `content[].text` → `from_str`。
- 验收：① `tools` 长度 == 25（24 + `run_command`，§3.1）；② `lumen_status` 返 `{application:"LUMEN RAW", mode:"gui"|"headless"}`（`commands.py:200-201`）；③ 故意传未知键给 `rate_photos`，得到 `isError:true` 且 text 含 `unknown argument(s)`（`commands.py:116-118`）——证明**双错误通道都识别**。

**步 2.4 主循环切到 A 通道**
- 动作：`render_preview`（`mcp.py:160-162` → `commands.py:524-537`）、`get_edits`（`commands.py:354-364`）、`apply_edits`（`commands.py:398-415`）改走 A 通道；阶梯：preview 1024 → UI 放大到 2048（`commands.py:525`）。
- 验收：① 编辑器开着时 `lumen_status.mode == "gui"`，且每次 `apply_edits` 在编辑器里是一个可 Ctrl+Z 的步（`control.py:239-260`）；② 编辑器关掉时自动回落 headless（`mcp.py:77`）且**功能不降级**；③ `apply_edits` 后 `get_edits.changes` 反映新值（`commands.py:185-187`）。

**步 2.5 超时与重连**
- 动作：每次 request 带 `recv_timeout`（preview 60s / export 600s / 其他 120s）；超时或读线程 EOF → 标记 `Dead` → 指数退避重启（§6.1-G3）→ 重启后重跑 2.2+2.3。
- 验收：① 手动 `taskkill` sidecar，下一次 UI 操作自动恢复且**不白屏**（先返回"正在重连"，成功后补渲染）；② 连续 5 次崩溃后仍能恢复且退避不失控（上限 8s）；③ 编辑器开着但 GUI 卡死时，60s 后返回中文超时提示而非永久转圈。

**步 2.6 崩溃/异常下的缓存一致性**
- 动作：preview 缓存 key 纳入 "所用通道 + lumen version + 源文件 mtime + 兄弟 `.lumen` mtime"（`session.py:74-81` 会拾取兄弟工程）。
- 验收：外部改动 `.lumen` 后，宿主预览**必须**重新渲染而非返旧图；用触摸文件 mtime 的方式验证。

### 阶段 3 — 可选增强（P1/P2）

**步 3.1 `project.save` 打通宿主编辑态**
- 动作：宿主"保存编辑"→ `project.save`（`commands.py:601-608`），`output` 省略即兄弟 `.lumen`。
- 验收：`.lumen` 生成；用 `lumen-cli info <photo>` 或 `edit.get full=true` 能读回刚存的值（`commands.py:362-363`）。

**步 3.2 XMP 互通**
- 动作：`run_command{command:"library.write_xmp", args:{paths}}`（`commands.py:301-306`）与宿主 `xmp.rs` 输出做 round-trip 比对。
- 验收：宿主写的 `crs:*` 与 lumen 读回的 `rating/flag/label` 一致；反向亦然；**原照片文件 mtime 不变**（lumen 只写真，`commands.py:301`）。

**步 3.3 C 通道命名管道（仅当"用户可见 agent 操作"成为硬需求）**
- 动作：探测 `\\.\pipe\lumen-raw-control-<user>`（`control.py:34-49`）；帧按 §4.2；`Mutex` 串行 + 读超时。
- 验收：编辑器开着时同一条编辑在窗口可见、可 Ctrl+Z；管道不可用时无缝回落 A 通道且 UI 无差异。

**步 3.4 收尾**
- 动作：补 `LumenState` 的 Drop（关 stdin → 等退出 → kill）；`api.ts` 新方法补 JSDoc；`src/types/index.ts` 补 `LumenStatus`/`LumenPreviewResult`/`LumenEdits`/`LumenChanges`。
- 验收：应用退出后**无残留 `lumen-cli.exe` 进程**（`tasklist` 验证）；`lumen_logs_cmd` 能读回 stderr 环形缓冲最后 100 行。
