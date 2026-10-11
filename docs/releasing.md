# 发布质量与升级

## v0.9.0 检查记录（2026-10-11）

检查对象为 tag `v0.9.0` / `e9b765bb916a9858c3a76c29b85a6af23cf0fb66`；
修复基于 main `55add61`，保留标签之后的 MCP 开发内容。

| 结论 | 证据与影响 |
| --- | --- |
| **确认：Windows 更新下载地址失效** | `latest.yml` 的 `files[0].url` 和 `path` 是 `StableWorker-Setup-0.9.0.exe`，Release 实际文件为 `StableWorker.Setup.0.9.0.exe`；前者 HTTP 404。构建器生成带空格的文件名，外部上传后名称与元数据不一致。手动下载实际 EXE 与自动更新下载是不同路径。 |
| **确认：macOS 更新载荷缺失** | `latest-mac.yml` 仅列出 x64/arm64 DMG，Release 无 ZIP。锁定版本 electron-updater 6.8.9 的 MacUpdater 会抛出 `ERR_UPDATER_ZIP_FILE_NOT_FOUND`。存在元数据文件不代表其内容可用于更新。 |
| **确认：macOS 跳过发行签名** | 两个架构的 Build 日志均明确记录 `skipped macOS application code signing` / `CSC_IDENTITY_AUTO_DISCOVERY=false`。Squirrel.Mac 要求代码签名；补 ZIP 不能修复已安装的未签名客户端。未见公证步骤。 |
| **确认：Windows EXE 无嵌入式 Authenticode 签名** | 已下载的 EXE 头部为有效 PE，Security Directory 的证书偏移与长度均为 0。此项仅检查头部，不是完整下载、哈希校验或安装测试。构建日志中出现 “signing with signtool.exe” 不能单独证明实际签名。 |
| **确认：更新资格判断错误** | 原代码以 `version !== app.getVersion()` 判断可下载，会把旧版本或被系统/灰度规则排除的版本当作更新；更新库会拒绝，造成错误提示，并不等于成功降级。原下载提示也没有取消按钮。 |
| **确认：版本文档不一致** | README 写 v0.6.0，锁文件根版本写 0.8.0，package.json / Release 为 0.9.0。 |
| **已核对：包格式与清单大小** | Windows 为 NSIS x64（114830352 字节），Linux 为 AppImage x64（130492122 字节），macOS 为 x64 DMG（137022488 字节）及 arm64 DMG（133121990 字节）。元数据大小与 GitHub 资产 API 一致；SHA-512 字段格式有效，未据此宣称内容哈希已验证。 |
| **尚未验证：已发布文件的完整 SHA-512** | 大文件下载速度受限，未完成四个安装包的完整下载。不能将 GitHub 提供的 SHA-256 或元数据中的 SHA-512 字段等同于本地重新计算的内容校验。 |
| **尚未验证：设备安装与升级** | Windows SmartScreen/UAC、macOS Gatekeeper/Intel/Apple Silicon/Rosetta、Linux FUSE/执行权限/可写目录，以及安装后启动、数据保留、失败重试均需实际设备验证。CI 绿色不代表这些测试成功。 |

来源：[Release](https://github.com/davidapp/stableworker/releases/tag/v0.9.0)、
[Build 日志](https://github.com/davidapp/stableworker/actions/runs/38141270302)、
[Check](https://github.com/davidapp/stableworker/actions/runs/38141257655)、
[electron-builder v26 自动更新要求](https://www.electron.build/v26/docs/features/auto-update/)、
[macOS 签名](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)。

## 本次修复

- Windows 安装包使用无空格的 `StableWorker-Setup-${version}-${arch}.exe`，避免上传改名；macOS 同时生成两个架构的 DMG 和 ZIP，上传全部更新载荷。
- 构建前检查 package.json、锁文件和 v* 标签版本。构建后及三平台产物合并后，逐项检查元数据版本、文件存在性、架构所需格式、字节大小、完整 SHA-512、旧版 path/sha512 字段一致性及 NSIS blockmap。
- 仅上传 `latest*.yml`，不再把 builder-debug.yml 当作发布资产。Linux 明确构建 x64，避免运行器架构变化导致兼容性漂移。
- 更新流程依赖 `isUpdateAvailable`，禁止降级和预发布版本，允许取消下载；处理并发检查、下载失败重试、不受支持的安装方式和已下载更新。稍后安装的提示明确说明退出时安装。
- 正式标签构建先通过类型检查和测试。macOS 必须签名、公证并通过 codesign/spctl/stapler 检查，之后才汇总产物创建 **Draft Release**。设备验收后再公开，避免用户看到上传未完成的更新。手动 workflow_dispatch 仅生成测试 Artifact，不改写滚动 latest Release。

## 证书与发布步骤

macOS 在 GitHub Actions Secrets 配置 `MAC_CSC_LINK`（Developer ID Application 的 .p12，推荐 base64）、
`MAC_CSC_KEY_PASSWORD`（证书密码，允许空密码）、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`。
正式标签缺少证书或公证身份时明确失败，不再静默发布未签名的 macOS 包。
本次未创建证书或配置 Secrets，签名与公证路径尚需在有凭据的 macOS 运行器验证。

Windows 可配置 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`；有证书时强制签名成功，
缺少证书时仍允许构建并输出明确警告。保留更新库的签名校验；签名版本的发布者名称从证书生成，
后续更新须保持发布者兼容。签名不能保证所有设备都不会出现 SmartScreen 提示。

1. 新补丁版本需高于 0.9.0，使用 `npm version <版本号> --no-git-tag-version` 同步 package.json 与锁文件，并更新 README。
2. 运行 `npm ci`、`npm run check:version`、`npm run typecheck`、`npm test`。
3. 提交并创建匹配版本的 v* 标签，等待所有平台构建、文件校验及 macOS 签名/公证验证通过。
4. 在隔离测试环境完成下面的设备验收，填写版本、系统、CPU、结果及日志证据。
5. 核对 Draft Release 的全部资产，再手动公开。不要替换已发布版本的二进制或重复使用相同版本号发布修复。

已发布 v0.9.0 的 Windows 元数据仍需单独修复：在完整下载并确认 EXE SHA-512 与清单一致后，
可把 `latest.yml` 的 `files[].url` / `path` 改为实际点号文件名，或增补与原清单同名的 EXE 和 blockmap。
本次代码修复不修改线上 Release。macOS v0.9.0 用户应手动迁移到后续已签名且公证的新版本，
不能承诺从未签名旧版自动升级；更早且没有 updater 的版本也需要手动安装。
安装和更新保持 `appId=com.david.stableworker`、应用名及数据目录不变。

## 设备验收清单（当前均未执行）

| 环境 | 必须验证的行为 |
| --- | --- |
| Windows x64，普通用户 | 从浏览器下载并保留系统来源标记；检查 Authenticode、SmartScreen/UAC、默认及自选目录安装、首次启动；v0.9.0 → 更高版本检查/取消/下载/稍后退出安装/立即重启；断网、损坏下载、重复点击；验证项目、设置和会话保留。 |
| macOS Intel | DMG 拖入 Applications 后卸载镜像；验证签名、公证、Gatekeeper 与首次启动；未签名 v0.9.0 手动迁移；同一签名身份的两个递增版本通过 ZIP 更新、重启并保留数据。 |
| macOS Apple Silicon | 原生 arm64 及 Rosetta x64 旧版本分别测试，检查 ZIP 选择正确、无架构错装；验证相同的签名、迁移、更新与数据保留流程。 |
| Linux x64 | 在目标发行版验证 AppImage 执行权限、FUSE/沙箱依赖、首次启动、可写目录内更新替换与重启；只读目录失败应保留旧版本；非 AppImage 启动不应误报“最新版本”。 |

发布资产检查命令：`npm run verify:release -- <包含安装包和元数据的目录> all`。
此检查会拒绝缺 ZIP、文件改名、大小或哈希不匹配等缺陷，但不会执行安装器，也不会验证 UI 启动或数据迁移。

## 本次修复的验证结果

代码与配置提交 `3050461` 已完成以下验证：

- 本机版本检查、TypeScript 检查、76 项单元测试全部通过，其中 15 项为本次新增回归测试。
- 本机 Windows NSIS 构建完成，使用本机已有的同版本 Electron 44.5.1 二进制以避开网络下载限制；生成文件名与 latest.yml 一致，完整 SHA-512、大小及 blockmap 存在性检查通过。Authenticode 状态为 `NotSigned`。
- [三平台 Build](https://github.com/davidapp/stableworker/actions/runs/38151665304) 成功：Windows NSIS x64、Linux AppImage x64、macOS x64/arm64 的 DMG+ZIP 均完成构建，清单逐文件引用、大小和完整 SHA-512 验证通过，Artifact 上传成功。
- [PR Check](https://github.com/davidapp/stableworker/actions/runs/38151668264) 的版本检查、类型检查及测试通过。
- 此次为分支上的手动测试构建：macOS 无签名身份，签名/公证验收步骤按设计跳过；创建 Release 的步骤也跳过。不能将成功结果解读为已签名、已公证、已安装、已完成真实升级，或已修复线上 v0.9.0。

这些是修复分支新生成的测试产物，与前面审计的 v0.9.0 已发布资产不同。正式发布应使用递增的新版本，配置 macOS 凭据并完成设备验收。
