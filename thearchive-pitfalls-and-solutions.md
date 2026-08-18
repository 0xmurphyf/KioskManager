# TheArchive 全程踩坑与解决办法

> 这份文档按项目生命周期重新整理，覆盖合约、Mainnet、ownership、Kiosk、Marketplace、图片、Coin、scan、UI、钱包、部署和验收。
>
> 重要原则：本地源码、build、Git push、线上部署、浏览器行为、Mainnet runtime 是五类不同证据，不能互相替代。

## 目录

1. 合约与 Mainnet runtime
2. Archive transaction 与 Original Image
3. Owner、Kiosk 和 Marketplace
4. DenyList、TransferPolicy 与安全状态
5. Scan、Indexer、Archive filter 与 stale 数据
6. 图片、metadata、IPFS、Walrus 与 Coin icon
7. Coin 处理
8. Choose Object、filter 与 card UI
9. Continue、preflight 与 transaction 安全
10. Wallet、网络和连接
11. Server、GraphQL、缓存和错误处理
12. 部署、测试与验收
13. 当前统一状态模型
14. 后续排查清单

---

# 1. 合约与 Mainnet runtime

## 1.1 本地 Move build 不等于 Mainnet 已生效

### 坑

本地 `sui move build` 成功，只能证明源码能编译，不能证明 Mainnet 已经 upgrade。

### 解决

必须额外确认：

- Mainnet package 是否真的 upgrade；
- published-at package；
- original package ID；
- package version；
- package linkage；
- 链上 bytecode 是否包含当前逻辑。

---

## 1.2 Published-at package 与 original package 用途不同

### 坑

交易 target、event type、package 查询混用不同 package，导致交易验证失败或 event 查询为空。

### 解决

明确分开：

```text
RUNTIME_PACKAGE_ID
```

用于当前交易 target。

```text
EVENT_PACKAGE_ID
```

用于查询 canonical/original `MemoryArchived` event。

---

## 1.3 Transaction target 曾经指向旧 runtime

### 表现

```text
VMVerificationOrDeserializationError
```

或者 simulation 失败，但本地 build 没问题。

### 解决

交易使用包含当前 bytecode 和 metadata validation 的 Mainnet published-at package；event 查询仍使用 original package。

---

## 1.4 archive event package ID 写错

### 坑

查询时 package ID 少字符或使用了 runtime package，导致真实 archive event 被误判为不存在。

### 解决

- 使用准确的 canonical package；
- 加入前端硬编码 fallback；
- 查询失败时不能静默假设没有 archived object；
- 读取分页全部 events。

---

## 1.5 本地 Published.toml 不能当 runtime 事实

### 坑

本地 `Published.toml` 只是本地记录，不能证明当前 Mainnet package 状态。

### 解决

所有最终结论以 Mainnet GraphQL、transaction、package object 和实际 bytecode 为准。

---

## 1.6 Version、published-at、original-id 不能混为一谈

### 坑

package version、published-at package、original package ID 是不同概念。

### 解决

报告时单独列出：

```text
runtime target
published-at
original-id
linkage
version
```

---

## 1.7 Event type 必须使用完整 Move type

### 坑

只拼接 package ID，忽略 module 或 event 名称；或者 query 使用模糊 type。

### 解决

使用完整：

```text
<package>::memory_archive::MemoryArchived
```

server listener、GraphQL filter、前端 archive filter 必须保持一致。

---

## 1.8 Archive contract 的 event 字段有两套语义

### 坑

只读取 `archive_id`，忽略 `original_object_id` 和 `artifact_id`。

### 解决

archive filter 同时匹配：

```text
archive_id
original_object_id
artifact_id
```

---

## 1.9 `MemoryArchived` event 不是当前 owner 数据

### 坑

把 `archived_by` 直接等同于经济意义上的原主人。

### 解决

`archived_by` 表示 archive event 中记录的操作者。若需要确认前主人，还要查 archive transaction input ownership 和 object 前一版本。

---

## 1.10 immutable Memory 不能事后补图

### 坑

旧 Memory 已 immutable，之后再修改 `image_url` 不可行。

### 解决

图片、source、storage、hash 必须在 archive transaction 中一次性写对。旧 Memory 只能通过新 archive 流程重新生成，不能原地修复。

---

# 2. Archive transaction 与 Original Image

## 2.1 普通 object 与 Kiosk object 的 Continue 流程曾不一致

### 坑

只有部分 object 走 Original Image，Kiosk object 走另一套流程。

### 解决

普通 object 和 Kiosk object 都走 Original Image；Kiosk 额外传递 Kiosk ID、OwnerCap 和必要 context。

---

## 2.2 不应因为“Original Image”就跳过所有 preflight

### 坑

把 Original Image 误解为可以不验证 ownership、lock、policy 和 input。

### 解决

Original Image 只代表 image source；Mainnet ownership、Kiosk lock、TransferPolicy、DenyList、object existence 仍然需要验证。

---

## 2.3 data URI 不能直接作为大型 pure argument

### 坑

把大 `data:image/...` 直接放进 PTB，触发：

```text
maximum pure argument size is 16384
```

### 解决

```text
data:image
→ /api/uploads
→ 外部 URL
→ 读取真实 bytes
→ 计算 hash
→ preflight
→ transaction
```

---

## 2.4 图片展示和交易参数必须分开处理

### 坑

为了让卡片显示 data URI，把 data URI 也直接用于 transaction。

### 解决

展示层可以允许合法 `data:image`；交易层仍然必须 externalize，不能把 data URI 直接传入 Sui PTB。

---

## 2.5 image hash 不能凭空生成

### 坑

metadata 没有 hash 时随便计算或填一个默认值。

### 解决

- metadata 有真实 hash：直接 copy；
- Online / Uploaded image：读取真实 bytes 计算 SHA-256；
- 没有真实 bytes：传空 hash；
- 不能伪造 hash。

---

## 2.6 `image_hash` 与 `imageHash` 都要支持

### 坑

只读取 snake_case 或 camelCase 一种字段。

### 解决

统一读取：

```text
image_hash
imageHash
```

---

## 2.7 Uploaded image 不能冒充永久存储

### 坑

普通 `/api/uploads` 文件被描述成永久、不可变、去中心化存储。

### 解决

明确区分：

```text
Original Image
Online Image
Uploaded Image
```

Uploaded image 的生命周期、URL 和存储性质必须如实表达。

---

## 2.8 preflight 错误不能被宽泛吞掉

### 坑

遇到 VM error、input object error 或 size error，只显示一个通用 fallback。

### 解决

区分：

- package mismatch；
- object not found；
- ownership failure；
- Kiosk lock；
- TransferPolicy lock；
- pure argument too large；
- upload failure；
- RPC / GraphQL failure。

---

## 2.9 `txApi is not defined`

### 坑

Choose Object inline script 直接使用不存在的 `txApi`，造成全局按钮失效。

### 解决

从：

```js
window.theArchiveTx
```

获取 API，并在 API 未加载时显示 reload 提示。

---

## 2.10 inline script 一个语法错误会影响全页面

### 坑

inline script syntax error 不只影响一个按钮，可能使所有 `onclick` 都失效。

### 解决

每次修改 inline JavaScript 后运行：

```bash
node --check
```

并用浏览器 console 验证零 JS error。

---

# 3. Owner、Kiosk 和 Marketplace

## 3.1 Owner 不是一个简单字符串

### 坑

只读取一个 owner address，忽略 GraphQL owner union。

### 解决

处理：

```text
AddressOwner
ObjectOwner
Shared
Immutable
ConsensusAddressOwner
Unknown
```

---

## 3.2 `ObjectOwner` 不是钱包 owner

### 坑

看到 object 进入 wallet/indexer 列表，就当作钱包直接拥有。

### 解决

继续追踪 `ownerObjectId`、dynamic field 和 parent object。

---

## 3.3 Kiosk NFT 的 owner 不是钱包地址

### 正确链路

```text
wallet
→ KioskOwnerCap
→ Kiosk
→ dynamic field
→ NFT
```

### 解决

scan Kiosk、KioskOwnerCap、dynamic fields，并把 context 合并到 NFT。

---

## 3.4 Kiosk item 的唯一性不能绕过 TransferPolicy

### 坑

认为 item 唯一，所以可以直接 take 或 archive。

### 解决

即使只有一个 item，也必须检查 Kiosk lock 和 TransferPolicy。

---

## 3.5 Kiosk lock 和 TransferPolicy 曾经被混为一谈

### 解决

UI 统一显示：

```text
IN KIOSK → 橙色
LOCKED → 红色
```

`LOCKED` 优先级高于普通 `IN KIOSK`。

---

## 3.6 Kiosk context 并发返回时会互相覆盖

### 坑

后返回的普通 Kiosk context 覆盖先返回的 `locked: true`。

### 解决

对已有 `kioskItemContext` 做字段级 merge，不允许后返回空状态覆盖已确认状态。

---

## 3.7 缺少 Kiosk ID 不能默认允许

### 坑

只有 `ownerObjectId` 或一个模糊线索，就当作可直接 archive。

### 解决

Kiosk 流程要求足够的：

- Kiosk ID；
- OwnerCap；
- item context；
- lock preflight。

缺少时阻止或标记待确认。

---

## 3.8 Marketplace delegated owner 被漏掉

### 坑

TradePort 返回：

```json
{
  "owner": "钱包地址",
  "delegatedOwner": "Listing object"
}
```

只看 `owner` 会误认为普通钱包 object。

### 解决

优先使用：

```text
delegated_owner || owner
```

非当前钱包、非 Kiosk 的 delegated owner 识别为 marketplace/object controlled。

---

## 3.9 `ownerObjectId` 曾在 merge 中丢失

### 坑

第一次 enrichment 得到 owner object，后续 scan merge 没有保留。

### 解决

merge 时保留：

```text
ownerObjectId
objectStatus
ownershipStatus
```

---

## 3.10 Marketplace object 的黄色文案曾不准确

### 坑

使用过于技术化或容易误解的 `SPECIAL OWNERSHIP`。

### 解决

当前文案：

```text
LISTED / OBJECT CONTROLLED
```

---

## 3.11 ObjectOwner 不一定等于 Listing

### 坑

看到 ObjectOwner 就直接写成 Marketplace。

### 解决

只有追到 Listing、Store、delegated owner 或明确 marketplace context 后，才显示 `LISTED / OBJECT CONTROLLED`；普通未知 ObjectOwner 应显示待确认状态或阻止继续。

---

## 3.12 没有 owner 不能默认是普通可 archive object

### 解决

以下状态不能默认允许：

```text
Unknown
Shared
Immutable
ObjectOwned
owner context 不完整
```

---

# 4. DenyList、TransferPolicy 与安全状态

## 4.1 `LOCKED` 和 `BLOCKED` 来源不同

### LOCKED

来源：

```text
0x2::kiosk::Lock
TransferPolicy
```

### BLOCKED

来源：

```text
0x403::deny_list::DenyList
```

两者不能共用同一判断函数。

---

## 4.2 DenyList dynamic field 存在不代表 blocked

### 坑

仅仅看到 AddressKey 或 ConfigKey，就显示 blocked。

### 解决

必须结合当前 epoch 和 setting 内容判断。

---

## 4.3 DenyList 判断必须 epoch-aware

需要检查：

```text
older_value_opt
newer_value
newer_value_epoch
current epoch
```

---

## 4.4 DenyList GraphQL page size 曾经错误

### 坑

使用不合法 page size，查询失败后静默返回空结果。

### 解决

使用合法分页，并在查询失败时输出明确日志，不把失败当成“没有 blocked”。

---

## 4.5 LMAGMA 不能被误标记 blocked

Mainnet 查询显示对应 ConfigKey 不存在，因此：

```text
不能认定 LMAGMA blocked
```

---

## 4.6 `NO STORE` 不是普通 ownership 状态

### 坑

没有 `STORE` ability 的 object 被简单标成橙色或继续 archive。

### 解决

单独显示：

```text
NO STORE CANNOT ARCHIVE
```

Continue 必须阻止。

---

## 4.7 `NO STORE` 不能被 Kiosk 状态覆盖

状态优先级：

```text
NO STORE 独立安全阻止
LOCKED 红色
BLOCKED 红色
IN KIOSK 橙色
LISTED / OBJECT CONTROLLED 橙色
```

---

## 4.8 UI 状态不能代替 Continue 校验

### 坑

卡片没有红色提示，就直接允许继续。

### 解决

Continue 重新读取 `selectedModel` 和 dataset，并对关键状态再次判断。

---

# 5. Scan、Indexer、Archive filter 与 stale 数据

## 5.1 RPC scan、Indexer scan、Kiosk scan 结果结构不同

### 坑

直接把三种来源当成同一 schema。

### 解决

统一字段映射：

```text
objectId
type
name
imageUrl
imageHash
isCoin
balance
ownerAddress
ownerObjectId
kioskId
kioskOwnerCapId
locked
blocked
noStore
objectStatus
ownershipStatus
```

---

## 5.2 Indexer 不是 Mainnet 最终事实

Indexer 可能：

- 延迟；
- stale；
- owner 字段语义不同；
- delegated owner 分开保存；
- object 已删除仍保留；
- 图片 URL 失效。

关键状态必须用 Mainnet GraphQL/RPC 交叉验证。

---

## 5.3 scan 结果曾被整批覆盖

### 坑

```js
wizardObjects = newScanResults
```

导致图片、lock、blocked、Kiosk context 消失。

### 解决

按 object ID 增量 merge。

---

## 5.4 merge 不能用空字段覆盖真实字段

### 坑

新 scan 返回空 `imageUrl`、空 `locked` 或空 owner，覆盖旧的真实值。

### 解决

使用字段级规则：

```text
incoming 有值 → 更新
incoming 缺失 → 保留 previous
```

---

## 5.5 `ownerObjectId` 也必须参与 merge

这是导致 `LISTED / OBJECT CONTROLLED` 消失的直接原因之一。

---

## 5.6 完整 scan 和不完整 scan 必须区别

```text
scanIncomplete = true
→ 保留旧结果

完整 scan
→ 移除当前不存在的 stale object
```

---

## 5.7 Archived object 不能只靠 object 当前 existence 过滤

### 坑

Archived object 当前 GraphQL 为 null，无法依赖 RPC scan 发现它已经 archive。

### 解决

必须先读取 `MemoryArchived` event，再过滤 indexer 结果。

---

## 5.8 Archive filter 必须在 merge 后、render 前执行

正确顺序：

```text
RPC + indexer merge
→ 保留字段
→ archivedIds filter
→ stale cleanup
→ render
```

---

## 5.9 Filter 曾经被错误删除

### 坑

把“不打断 scan”误解成“删除 All/NFT/Coin”。

### 解决

恢复三个按钮，filter 只改变显示集合。

---

## 5.10 Filter 不能触发后台重扫

filter 切换不能：

- 清空 grid；
- 重置 scan cursor；
- 重建 wallet state；
- 丢失已有 object。

---

## 5.11 Filter 只在多个可选 object 时显示

当前规则：

```text
可选择 object > 1
→ 显示 All / NFT / Coin
```

SUI native coin 不计入可选择 object 数量。

---

## 5.12 Scan 中途切换 filter 不能隐藏后台结果

filter 只影响当前 render；后台 scan 继续把新结果写入完整集合。

---

## 5.13 archivedIds 查询失败不能静默当作空集合

当前至少使用 canonical package fallback，并输出 warning。生产环境还应考虑在 UI 显示 archive filter unavailable，而不是让用户以为结果完整。

---

## 5.14 不同钱包切换必须清空旧钱包数据

### 坑

如果不清空，钱包 A 的 object 可能出现在钱包 B。

### 解决

钱包地址变化时清空旧 `wizardObjects`、selection、scan state 和 indexed merge state。

---

## 5.15 手动 Object ID 与自动 scan 不能混为一谈

Manual object 应保留：

```text
manual = true
```

完整 scan 清理 stale object 时，不能把用户手动输入的 object 一起清掉。

---

# 6. 图片、metadata、IPFS、Walrus 与 Coin icon

## 6.1 只支持 `image_url` 会漏掉 NFT 图片

当前支持：

```text
image_url
imageUrl
media_url
mediaUrl
url
artifact.image_url
artifact.imageUrl
artifact.url
display image fields
```

---

## 6.2 `media_url` 可能是图片，也可能是 metadata endpoint

### 坑

看到 `media_url` 就一定当作最终图片。

### 解决

需要检查：

- Content-Type；
- 是否直接返回 image；
- 是否返回 JSON metadata；
- JSON 中是否还有 image / image_url / url 字段。

---

## 6.3 `ipfs://` 不能直接作为 img src

需要 normalize 到 HTTP gateway。

---

## 6.4 `walrus://` 不能直接作为 img src

需要转成 Walrus aggregator URL。

---

## 6.5 gateway failure 不能直接判定无图

需要多 gateway fallback，并保留原始 URL。

---

## 6.6 CoinMetadata iconUrl 可能是 data URI

卡片显示允许 `data:image`，交易参数仍需 externalize。

---

## 6.7 Image error handler 不能只替换一次

IPFS 失败后需要顺序尝试多个 gateway；所有 gateway 失败后才进入 fallback。

---

## 6.8 Coin 图片失败后不能显示空白

最终至少显示 Coin symbol glyph。

---

## 6.9 Collection image logic 曾经和 Object 不一致

现在 collection 复用：

```text
safeObjectDisplayImageUrl()
fallbackObjectImage()
```

---

## 6.10 Collection cover 也要支持 data URI

不能只对 object card 放开 data URI，collection card 也必须使用同一个 display sanitizer。

---

## 6.11 Collection cover 不能直接使用未经处理的 URL

必须先 normalize，再写入 `<img src>`。

---

## 6.12 Object、Collection、Archive hero 的图片规则要分别验证

三处使用场景不同，但必须保持：

```text
正方形区域
透明背景
contain
完整显示
```

---

## 6.13 图片缺失可能来自 stale asset

源码已经修复不代表线上 script 已更新。必须检查线上 asset 内容和 hash。

---

# 7. Coin 处理

## 7.1 原生 SUI Coin 不应进入 Choose Object

过滤：

```text
::coin::Coin<...::sui::SUI>
```

---

## 7.2 SUI address 可能是短地址或 64 位补齐地址

不能只匹配：

```text
0x2::sui::SUI
```

还要匹配补齐后的地址。

---

## 7.3 不能只依赖 `isCoin`

SUI 过滤直接依据完整 Move type，不依赖 indexer 是否正确设置 `isCoin`。

---

## 7.4 Coin symbol 不能硬编码成 SUI

Coin 显示必须从真实 Move type 推导 symbol，不能所有 Coin 都显示 SUI。

---

## 7.5 Coin balance 是 BigInt

不能用普通 JavaScript number 处理高精度 balance，应该在扫描、格式化和交易 amount 之间明确转换。

---

## 7.6 Coin split input 不能默认启用

只有选择对应 Coin object 后，amount input 才应启用。

---

## 7.7 未选择 Coin object 时不能继续

Continue 前必须检查：

- selected object；
- amount；
- amount 不超过 balance；
- amount 格式合法。

---

## 7.8 CoinMetadata 可能不存在

metadata 查询失败不能阻止普通 Coin 显示；应使用 symbol glyph fallback。

---

## 7.9 Coin icon 的 data URI 可能很大

UI 可以显示，交易前仍要 externalize，避免纯参数 size limit。

---

# 8. Choose Object、filter 与 card UI

## 8.1 Object card 高度被长名字撑坏

解决：

- 固定 card height；
- name clamp；
- object ID ellipsis；
- balance 截断；
- warning wrap。

---

## 8.2 图片区域不能被文字挤压

图片区域固定为正方形，使用：

```css
object-fit: contain
```

---

## 8.3 Mobile warning 文案太大

手机端单独缩小：

```text
name 10px
object ID 8px
status 7px
warning 8px
```

---

## 8.4 Warning 文案中不使用横线字符

当前文案：

```text
NO STORE CANNOT ARCHIVE
LOCKED TAKE OUT FIRST
LISTED / OBJECT CONTROLLED
```

---

## 8.5 Warning 链接不能触发 card selection

使用：

```html
onclick="event.stopPropagation()"
```

并用：

```html
target="_blank"
rel="noopener noreferrer"
```

---

## 8.6 状态优先级必须稳定

推荐优先级：

```text
NO STORE
LOCKED
BLOCKED
IN KIOSK
LISTED / OBJECT CONTROLLED
普通 object
```

---

## 8.7 `LOCKED` 与 `BLOCKED` 颜色必须保持红色

不能被普通橙色 ownership 状态覆盖。

---

## 8.8 Kiosk 和 Listed 状态使用橙色

```text
IN KIOSK
LISTED / OBJECT CONTROLLED
```

---

## 8.9 Unknown owner 不能显示成普通可操作状态

可以使用橙色待确认状态，或直接阻止 Continue，但不能伪装成普通 AddressOwner。

---

## 8.10 Collection card 点击不能破坏 scan state

打开 collection 只是设置当前 collection filter，不应重新扫描或删除 object。

---

## 8.11 Search 与 filter 必须可组合

搜索只改变显示集合，不修改底层 `wizardObjects`。

---

## 8.12 没有可选择 object 时要显示准确提示

隐藏 SUI 后，如果钱包只剩 SUI，显示：

```text
No selectable objects found in this wallet.
```

而不是错误显示“钱包未连接”。

---

# 9. Continue、preflight 与安全

## 9.1 UI card 没有 warning 不代表安全

Continue 必须重新读取 selected model 的真实字段。

---

## 9.2 普通 object 也必须检查 `STORE`

没有 `STORE` 的 Move object 不能放入 `Memory<T: key + store>`。

---

## 9.3 Kiosk locked 必须在 Continue 前阻止

不能等 transaction 失败后才告诉用户。

---

## 9.4 Blocked 必须在 Continue 前阻止

DenyList 状态明确时，Continue 不能继续 archive。

---

## 9.5 Listed/object controlled 不应当作普通 owner archive

当前已有 `ownerObjectId` 时，Continue 应阻止或要求用户先解除 marketplace control。

---

## 9.6 未选 object 不得进入下一步

---

## 9.7 Online image 没有有效链接不得继续

---

## 9.8 Upload image 未选择文件不得继续

---

## 9.9 大图片必须在 preflight 前 externalize

不能等 transaction serialization 失败后才处理。

---

## 9.10 Preflight 失败不能显示成功

失败必须保留明确原因，不可用宽泛 fallback 掩盖真实错误。

---

# 10. Wallet、网络和连接

## 10.1 Wallet 连接成功不代表 network 正确

必须检查是否为 Sui Mainnet。

---

## 10.2 Testnet object 不能混入 Mainnet archive

非 Mainnet wallet 必须阻止继续。

---

## 10.3 不能只支持浏览器 extension

需要考虑：

- Wallet Standard；
- 浏览器扩展；
- Slush App 内置浏览器；
- mobile wallet browser。

---

## 10.4 不能为了规避 metadata 403 永久禁用 Slush

应提供兼容方案，而不是删掉 wallet 支持。

---

## 10.5 钱包切换必须重置对象列表

防止钱包 A 的 object 残留到钱包 B。

---

## 10.6 私钥、助记词和 UpgradeCap 不能进入聊天或源码

敏感信息必须使用本机安全导入、临时文件或环境变量，不能提交 Git。

---

# 11. Server、GraphQL、缓存和错误处理

## 11.1 GraphQL schema 不能凭记忆猜

字段名、union 类型、分页结构要先 introspection 或实际查询验证。

---

## 11.2 GraphQL union owner 必须使用 inline fragments

例如：

```graphql
... on AddressOwner
... on ObjectOwner
... on Shared
... on Immutable
```

---

## 11.3 GraphQL 分页不能只取一页

Event、dynamic fields、Coin objects、Kiosk items 都可能超过一页。

---

## 11.4 GraphQL page size 必须符合服务端限制

错误 page size 会导致查询失败；不能静默返回空结果。

---

## 11.5 RPC JSON-RPC 已逐步弃用

Public fullnode 的旧 JSON-RPC 方法可能返回：

```text
Method not found
```

需要使用 GraphQL、gRPC 或官方新接口。

---

## 11.6 API failure 不能当成空数据

`fetch` 失败、GraphQL errors、HTTP 403、timeout 都不能简单变成空 object 列表，否则会误导用户。

---

## 11.7 Indexer API key 不应在聊天中暴露

现有配置和文档必须确保敏感 token、私钥、密码被 redact。

---

## 11.8 `/api/owned-objects` 需要保留 delegated owner

否则 marketplace ownership 无法在前端识别。

---

## 11.9 Server cache 不是 Mainnet truth

cache 只用于加速；关键 archive、owner、object existence 需要链上复核。

---

## 11.10 Image proxy 和 upload API 需要独立验证

不能因为 `/api/uploads` 成功，就认为外部图片 URL 一定可用；需要检查上传 response、URL、真实 bytes 和 hash。

---

# 12. 部署、测试与验收

## 12.1 Git push 不等于线上部署

必须检查线上：

- HTML；
- script asset；
- asset hash；
- 目标修复字符串；
- 浏览器 DOM。

---

## 12.2 Build 不等于浏览器验收

必须实际打开浏览器，检查：

- card；
- warning；
- filter；
- image src；
- console error；
- mobile layout。

---

## 12.3 Server tests 不等于 Mainnet 验收

server tests 只能验证本地逻辑，不能证明：

- Mainnet package 正确；
- object owner 正确；
- event 存在；
- transaction 成功；
- 钱包真实流程可用。

---

## 12.4 Simulation 不等于真实交易

Simulation 可以验证 target、参数和 VM 行为，但不能完全证明真实 wallet signature、gas、ownership 和最终 object/event。

---

## 12.5 SuiScan 显示图片不等于 TheArchive 能显示

不同平台可能使用不同 cache、gateway 或 metadata resolver。

---

## 12.6 线上 asset 必须重新核对

源码修复后需要检查线上是否包含：

- `media_url`；
- IPFS/Walrus normalize；
- Coin data URI display；
- filter logic；
- archived filter；
- delegated owner；
- mobile warning CSS。

---

## 12.7 每次 push 前的最低检查

```bash
node --check src/archive-tx.js
node --check server/indexer-owned-objects.mjs
node --check extracted-inline-script.js
pnpm build
pnpm test
git diff --check
git status
git push
```

---

## 12.8 浏览器 console 必须为零错误

尤其关注：

```text
txApi is not defined

Cannot read properties of undefined

GraphQL query failed

image load errors
```

---

## 12.9 Mainnet object 查询必须留证据

至少记录：

```text
object ID
type
version
digest
owner type
owner address/object
content
image field
archive event
transaction digest
```

---

## 12.10 不能用“应该”“大概”代替链上证据

无法确认时必须明确写：

```text
未确认

仅 indexer 证据

仅源码验证

仅 simulation 验证

尚未完成线上浏览器验证
```

---

# 13. 当前统一状态模型

## 13.1 状态定义

```text
NORMAL
普通钱包直接控制且通过安全检查

IN KIOSK
由 Kiosk 持有，橙色

LISTED / OBJECT CONTROLLED
由 Listing、Marketplace、Store 或其他 object 控制，橙色

LOCKED
Kiosk Lock 或 TransferPolicy 锁定，红色

BLOCKED
Sui DenyList 明确限制，红色

NO STORE
Move type 没有 STORE，独立阻止

UNKNOWN OWNERSHIP
无法确认 ownership，不能默认 archive

ARCHIVED
已有 MemoryArchived event，不进入 Choose Object

SUI NATIVE COIN
不进入 Choose Object
```

---

## 13.2 状态优先级

```text
ARCHIVED
  ↓ 不进入 Choose Object
NO STORE
  ↓ 独立安全阻止
LOCKED / BLOCKED
  ↓ 红色
IN KIOSK
  ↓ 橙色
LISTED / OBJECT CONTROLLED
  ↓ 橙色
UNKNOWN OWNERSHIP
  ↓ 橙色或阻止
NORMAL
```

---

## 13.3 图片处理顺序

```text
链上 image metadata
→ media_url / image_url / nested fields
→ normalize HTTP / IPFS / Walrus
→ data:image 仅展示层允许
→ gateway fallback
→ Coin symbol / NFT placeholder fallback
```

---

## 13.4 Scan 处理顺序

```text
Mainnet RPC scan
+ Kiosk scan
+ indexer scan
→ object ID merge
→ 保留已有字段
→ archive event filter
→ stale cleanup
→ SUI native coin filter
→ ownership enrichment
→ image enrichment
→ filter/search render
```

---

# 14. 后续排查清单

遇到“object 不对”时：

1. Mainnet object 是否存在？
2. 当前 version、digest 是什么？
3. owner 是哪种 union？
4. owner 是否是 ObjectOwner？
5. ObjectOwner parent 是什么 type？
6. 是否 Kiosk dynamic field？
7. 是否 Listing / Store？
8. 是否有 delegated owner？
9. 是否已产生 MemoryArchived event？
10. archive event package 是否正确？
11. indexer 是否 stale？
12. image 字段使用 image_url 还是 media_url？
13. URL 是否 ipfs/walrus/data URI？
14. gateway 是否实际返回 bytes？
15. CoinMetadata 是否有 iconUrl？
16. data URI 是否只用于显示？
17. transaction 前是否 externalize？
18. object 是否没有 STORE？
19. 是否 locked？
20. 是否 blocked？
21. scan 是否 incomplete？
22. merge 是否丢字段？
23. archivedIds 是否为空？
24. filter 是否错误触发 scan？
25. 线上 asset 是否包含最新代码？
26. 浏览器 DOM 是否显示最新文案？
27. console 是否有 JS error？
28. 移动端 card 是否溢出？
29. 钱包是否真的在 Mainnet？
30. 最终结论是源码、build、Git、线上还是 Mainnet 证据？

---

# 15. 最终经验

TheArchive 最容易出错的地方，不是单个函数，而是多个事实源之间的错位：

```text
源码状态 ≠ build 状态
build 状态 ≠ Git 状态
Git 状态 ≠ 线上部署状态
线上部署状态 ≠ 浏览器渲染状态
indexer 状态 ≠ Mainnet runtime 状态
当前 owner ≠ 历史 owner
archived_by ≠ 一定的经济意义前主人
image URL 存在 ≠ gateway 能返回图片
simulation 成功 ≠ 真实交易成功
```

因此最终验收必须同时满足：

```text
源码正确
build 通过
测试通过
Git 已 push
线上 asset 已更新
浏览器 DOM 正确
Mainnet owner/event/object 证据正确
真实 wallet 流程可用
```
