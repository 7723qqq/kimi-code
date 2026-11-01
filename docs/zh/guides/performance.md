# 启动性能

Kimi Code CLI 以单文件可执行程序分发，运行时内嵌在其中，因此每次调用都会启动一个新进程。启动时间值得被测量并保持在较小水平。

## 本次变化

原生可执行程序现在使用 **bytecode 预编译**。JavaScript bundle 在构建时就被编译成 bytecode（运行时预先解析后的形式），而不是每次启动时重新解析，因此进程能更快到达首个输入提示，同时占用更少内存。

源码不会被遮蔽：堆栈与错误信息仍然指向原始代码，构建保持可复现。

## 实测结果

在 Windows 11（Intel Core Ultra 9 285K，24 核，63 GiB 内存）上测量，使用逐个启动可执行程序并等待退出的进程计时方式；每个数字取 30 次运行的中位数。

| 场景 | 启用 bytecode 前 | 启用 bytecode 后 | 变化 |
|---|---|---|---|
| `kimi --version` | 604 ms | **283 ms** | 快 2.1 倍 |
| p95（95 分位） | 633 ms | 305 ms | −52% |
| 峰值工作集（进程活跃使用的内存） | 237 MB | **181 MB** | −24% |
| 可执行文件体积 | 185.5 MiB | 219.4 MiB | +18% |

同一台机器上与官方 Kimi Code 2.4.1（Node SEA 构建）对比：

| 场景 | 本构建 | 官方 2.4.1 |
|---|---|---|
| `kimi --version` | 277 ms | 471 ms |
| `kimi doctor config` | 280 ms | 488 ms |
| `kimi session list --json` | 476 ms | 576 ms |
| 峰值工作集（`--version`） | 181 MB | 298 MB |

实际耗时受硬件、存储和机器负载影响，更有参考价值的是两者的比例。

## 本地验证

::: code-group

```powershell [Windows]
# 构建当前平台的可执行程序
cd apps/kimi-code
bun run build:native:bun

# 先预热一次，再采样 30 次并取中位数
.\dist-native\bin\win32-x64\kimi.exe --version | Out-Null
1..30 | ForEach-Object {
  (Measure-Command { .\dist-native\bin\win32-x64\kimi.exe --version }).TotalMilliseconds
} | Sort-Object | Select-Object -Index 14
```

```bash [macOS / Linux]
cd apps/kimi-code
bun run build:native:bun

./dist-native/bin/*/kimi --version >/dev/null
for i in $(seq 30); do
  /usr/bin/time -f "%e" ./dist-native/bin/*/kimi --version >/dev/null
done
```

:::

## 面向贡献者

- bytecode 在 `scripts/native/build-bun.mjs` 中默认开启。
- 在 `bun run build:native:bun` 前设置 `KIMI_CODE_BUN_DISABLE_BYTECODE=1`，可构建不带 bytecode 的版本用于对比。
- 启动数据与构建所用的 Bun 版本相关，因为运行时被内嵌在二进制中。
