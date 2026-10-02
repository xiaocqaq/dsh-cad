# dsh-plugin-cad

[English](./README.md) | **简体中文**

让 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的 Agent **直接操作正在运行的 AutoCAD**:
读取图层与图元、绘制、标注、填充、修改、另存 DWG —— **不需要在 AutoCAD 内安装任何东西,也不需要编译任何 DLL**。

基于 Harness `0.2.0-rc2` 开发;已在 **AutoCAD 2026(R25.1.60.0,简体中文版)** 上完成真机联调验证。

## 为什么这样设计

参考评测报告(*Codex for CAD 工程应用评测报告*)测试了四种接入方式,结论是 **MCP 直连活 CAD** 最有价值;
但报告也实测出三个具体缺陷。本插件的设计正是围绕解决它们:

| 报告实测的缺陷 | 本插件的做法 |
| --- | --- |
| 「仅从图上测量时是有偏移500mm」—— 无比例尺,单位靠猜 | 所有工具一律以 **米** 为输入,由 `unitsPerMeter` 换算;返回值同时给出米和图纸单位 |
| "能不能准确选中对象"—— 选不中目标图元 | `cad_query_entities` 是强制的前置步骤;`cad_batch` 把"筛选 + 执行"合成一次原子调用,目标集合不会漂移 |
| 跨图层联动改图漏改对象 | `cad_transform` 对已解析的句柄集施加同一变换,相对间距由构造保证不变 |

三条接入路线都评估过:

- **生成 `.lsp` 让用户 `APPLOAD`** —— 正是报告里评价最低的方式,拿不到实时状态和返回值
- **编译 .NET DLL 塞进 AutoCAD** —— 能力最强,但需要 MSBuild + 每个 AutoCAD 版本换一次 DLL,且没有 .NET SDK 就无法构建和测试
- **stdio JSON 桥接 → AutoCAD COM** ✅ —— AutoCAD 本身就注册了自动化服务,可直接连**正在运行的**会话,无需在 CAD 内安装、无需编译

## 架构

```
dsh 工具  →  CadService(单位换算)  →  CadTransport
                                          ├── ComTransport        → assets/cad-bridge.ps1 → AutoCAD COM
                                          └── SimulationTransport → 内存图纸
```

传输层接口(`src/protocol.ts`)是可替换的接缝。`SimulationTransport` 是整个操作面的**真实实现**,不是打桩 ——
正因为有它,工具层、单位换算和测试都能在没有 AutoCAD 的机器上运行,也让你可以在不碰真实图纸的前提下演练提示词。

## 安装

```sh
dsh plugin --profile <你的配置名> add dsh-plugin-cad
```

或从本地检出安装:

```sh
pnpm install
dsh plugin --profile <你的配置名> add D:\code\dsh-plugin-cad
```

然后启动 AutoCAD、打开图形,再启动配置:

```sh
dsh web
```

## 配置

在配置的 `cordis.patch.yml` 里修改 `cad` 那一行:

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `transport` | `com` | `com` 驱动真实 AutoCAD;`simulation` 全内存运行 |
| `progId` | `AutoCAD.Application` | 主 COM ProgID |
| `progIdFallbacks` | `AutoCAD.Application.25.2` … | 主 ProgID 不存在时按顺序尝试 |
| `unitsPerMeter` | `1` | **毫米制图纸必须设为 `1000`**。用 `cad_status` 确认 —— 它会报告图纸自身的 `INSUNITS` |
| `requestTimeoutMs` | `120000` | 单次桥接往返的硬超时上限 |

非法配置会在插件加载时**直接报错**,而不是静默损坏几何。
## 工具一览

| 工具 | 用途 |
| --- | --- |
| `cad_status` | 连接状态、当前图形、单位比例。**从这里开始。** |
| `cad_open` / `cad_save_as` | 打开 DWG;另存到新路径 |
| `cad_list_layers` | 图层清单:颜色、线型、开关/冻结/锁定状态、图元数量 |
| `cad_query_entities` | 按图层、类型、文字或范围**定位图元**,返回句柄与米制尺寸 |
| `cad_get_entity` | 单个句柄的完整信息 |
| `cad_measure` | 测量两点距离,同时给出米与图纸单位 |
| `cad_draw` | 批量绘制直线 / 圆 / 圆弧 / 多段线 / 单行文字 / 多行文字 |
| `cad_add_dimension` | 真正的尺寸标注对象(线性 / 对齐 / 角度 / 半径 / 直径) |
| `cad_add_hatch` | 闭合区域填充 |
| `cad_modify` | 修改单个图元的属性 |
| `cad_transform` | 对一组句柄统一平移 / 旋转 / 缩放 |
| `cad_delete` | 按句柄删除图元 |
| `cad_batch` | 把"筛选 + 变换"合成一次原子操作,支持 `dryRun` 试运行 |
| `cad_run_command` | 逃生舱:执行 AutoCAD 原生命令 |

所有尺寸**进出都是米**。

## 安全约定

报告里的规范在工具契约层面被强制执行:

- 失败返回**结构化**错误,绝不静默吞掉
- 部分成功会被报告:被跳过的对象进入 `warnings`,并呈递给模型
- `cad_batch` 支持 `dryRun`,联动改图可先预览再执行
- `cad_query_entities` 截断时会明确说明,而不是把残缺结果伪装成完整结果

## 真机验证

```sh
# 1. 启动 AutoCAD 2026 并打开一个空白图形
# 2. 运行真机测试(它会绘制、检索、平移,然后删除自己创建的图元)
set DSH_CAD_LIVE=1
node --test --experimental-strip-types test/com-live.test.ts

# 不设置该环境变量时,真机测试会跳过,其余测试离线运行:
node --test --experimental-strip-types test/*.test.ts
```

完整套件共 **38 项测试全部通过**,其中 5 项真机测试需要已授权、正在运行的 AutoCAD。

## 真机联调踩坑记录

以下都是实际连 AutoCAD 2026 跑出来的,改动桥接脚本前务必先看:

- **请求可以跨多行书写**。桥接会累积输入直到花括号配平,因此手工写的多行 JSON 会被当作一个请求解析。字符串内容会被跳过,所以文字里的 `{` `}` 不会干扰嵌套计数。
- **AutoCAD 忙碌时会用 `RPC_E_CALL_REJECTED` 拒绝 COM 调用**(弹了对话框、正在重生成、用户命令执行中)。桥接会对这类瞬时错误做退避重试,所以 AutoCAD 界面的短暂卡顿不会变成工具报错。
- **绝对不要启用 `Set-StrictMode`**。严格模式下 PowerShell 会丢失 COM 类型适配器,之后每次属性访问都报 *"property cannot be found on this object"*。
- **绝对不要把 COM 对象传进函数**。跨函数边界同样会丢失适配器,导致 `$Doc.ModelSpace` 在辅助函数里**静默变成 null**。桥接把 `$script:Doc` 和 `$script:SPC` 放在脚本作用域,辅助函数只接收句柄和普通值。
- `Entity.Transform` 不存在,必须用 **`TransformBy` + 4×4 的 `double[,]` 矩阵**;传扁平 `double[]` 会报 *"安全数组维数不正确"*。
- `Entity.GetBoundingBox` 填充的是两个**出参**,不返回值:用 `$e.GetBoundingBox([ref]$min, [ref]$max)`。
- `Document.GetVariable` 存在,`Application.GetVariable` **不存在**。
- 图层和图元的颜色属性都叫 `Color`,`ColorIndex` 两者都不存在。
- 赋给不存在的图层会抛异常;桥接会按需自动创建图层。
- `cad_transform` 适用于 AutoCAD 能变换的任何图元类型,包括多段线和块;句柄失效时会在 `warnings` 里报告,而不是静默跳过。
- `StartUndoMark` / `EndUndoMark` 在自动化 `Document` 上不存在,而在自动化客户端里调用 `SendCommand` 会死锁。因此 `cad_draw` 的 `undoLabel` **被接受但不生效**;每个图元仍可用 `U` 单独撤销。
- `assets/cad-bridge.ps1` 必须保持 **UTF-8 with BOM**。否则 Windows PowerShell 5.1 会按 ANSI 读取中文字符串并解析失败。

## 开发

```sh
pnpm install       # 同时通过 `prepare` 脚本构建(git 安装时必需)
pnpm typecheck
pnpm build
pnpm test
```

`prepare` 会执行 `tsdown`,所以 `dsh plugin add github:you/dsh-plugin-cad` 无需 monorepo 检出即可工作。
首次安装时,需要在配置的 `pnpm-workspace.yaml` 里加入 `allowBuilds: { dsh-plugin-cad: true }` 来授权这一步构建。

## 已知限制

- `cad_draw` 的 `undoLabel` 见上文,当前不生效。
- COM 自动化是**静默**的:插件连接后在 AutoCAD 界面上没有任何视觉反馈(状态栏、功能区都没有)。需要确认连接状态时请调用 `cad_status`。
- 插件擅长**按明确参数创建和修改**图元,不擅长从图片逆向重建复杂自由曲线轮廓(圆角相切、斜边过渡等)。这类任务更适合 AutoCAD 原生的图像跟踪(PDF/图片描线)流程。

## 许可

MIT