# 规范化测量、SLO与证据交付

本页描述measurement-v1和接受条件v2；现有10个受管工具不变。示例档案见
[有界开发验收档案](examples/m1-profile-v2.json)。这不是用户业务SLO或正式容量测试档案。
所有模型启动、压测、比较与报告仍由Bittune经受管工具执行。

## 测量与统计

单点和suite都调用同一Core/EvalScope入口。每档有独立输出目录和Artifact集合，重复点
也不能混读前档数据。BenchmarkResult追加measurement对象，旧事实不改写。

- 每个指标都有固定名字/单位。值缺失为null，同时有unavailable_reasons；数值有metric_sources。
- input/output token总量和吞吐均限定成功请求，RPS也是成功请求数/测量窗口，错误率另看成功/失败计数。
- 测量窗口是正式请求原始start_time最小值至completed_time最大值，不能用报告生成耗时或反推RPS作窗口。
- duration/计数/token与分位数基于逐请求SQLite；原provider汇总和百分位表保留作原始证据，不能替代缺失样本。
- 分位数统一linear_n_minus_1_v1。非流式不造TTFT/TPOT/ITL零值；单token输出不造TPOT。
- ITL字段仍沿用现名，其来源是响应块间隔，不证明每块等于一个token。
- failed_requests包含所有非成功请求。provider没有失败分类时timeout_requests为null，
  unknown_failure_requests是failed_requests的子集，不要再相加；无失败时timeout为可证明的0。
- 原始Prompt/响应不进入指标导出。input_sha256按实际token-ID输入计算；dataset_input_sha256
  是无序多重集指纹，保留重复数，不证明到达顺序。

norm-v6优先使用上述原始窗口和token总量，可能与旧provider汇总的舍入值不同；
不是笼统改变分位数算法。Core同时保留原始文件与方法版本，禁止新旧口径混签。

## 接受条件

单点benchmark_service可选acceptance对象；suite通过profile_path读取完整档案。
接受条件与扫描registry要同时采用v2；不能与内置档案逐字段合并。

- request_limits_ms：每个成功请求的e2e/ttft/tpot/itl限值。请求ITL判断使用其最大响应块间隔。
- p99_limits_ms：整点P99限值，与逐请求判断分开；success_rate_min是整点请求成功率门槛。
- goodput_req_per_s = 逐请求满足所有已声明条件的成功数 / 有效测量窗口。
  goodput_output_tokens_per_second另按这些达标请求的实际输出token合计/窗口计算，两者单位不可混用。
  某点P99失败，仍可能有非零goodput；不能把“整点过关后的RPS”写成它。
- active条件缺观测或窗口不可用时，goodput不可用并保留原因，不当作0。
- latency_comparison=raw_ms保持原小数比较；只有显式floor_ms才对观测值向下取整毫秒比较，原始值不变。
- v1档案继续可读和按原聚合阈值判定；新执行的legacy_slo_passed_rps另名记录，goodput留空，避免混义。

内置短套餐每点4/8请求，仅用于回归。小样本P99不证明稳定尾延迟、容量或生产SLO。

## 套件状态与停止

v2行state=measured只表示测量完整。slo_status列出聚合通过/失败/不可用，
request_slo_status单列逐请求判定可用性，decision列出continue/confirm/stop。

一次SLO失败最多插入一个同并发确认点；连续同并发失败后停止该场景。成功率失败与
冻结比例的吞吐下降同时出现时停止；安全事件立即停。缺完整测量或必需观测不继续扩自适应并发。
confirm会产生独立repeat编号、BenchmarkResult和原始证据，不能拿第一次结果冒充重复验证。
invalid_measurement、not_run_early_stop、not_run_safety_stop、not_run_budget等状态均保留在导出中。

预算包含确认点。max_points/max_requests限制正式测量档数与请求数；Core warmup和provider
自身hello连接探测不进入测量SQLite，也不计正式请求预算。max_duration_seconds从模型预检结束
开始扫描计算，含档内准备，但不包含前面的部署/Ready；预算耗尽不再发新档，当前档仍受其请求timeout约束。
max_artifact_bytes按本次suite已写Artifact计数，超预算不截断已有证据。最终单个交付Artifact
仍有Core的8MiB上限，超限显式失败，可精确选择结果分组导出。

## 缓存、比较与身份

可签公平比较要求输入集合、采样、统计与SLO方法匹配，且有受管缓存关闭证据。
vLLM明确false必须编译为--no-enable-prefix-caching并由所选镜像支持，不能省略flag依赖默认值。
SGLang需要相应受管disable_radix_cache与实际CLI证明。配置声明本身或相同seed都不足够。

M1只签有证据的closed-loop输入集合比较；open-loop到达轨迹尚未取证，保留观测数字但不签公平结论。
未受管端点保持declared，不能伪装成bound。缓存未受控时可报告实际观测，但不发布公平比较收益。
冷/热缓存测试、准确率与P/D集群推算有各自证据门禁，不由本页的小范围性能契约代替。

## 报告与导出

write_report的指标断言只引用已有事实。新字段的单位、suite可引用指标和XLSX列来自
Core同一measurement-contract；不让Agent手填数字或在表里重算一遍。

export_deliverable可精确选择suite_result_id或benchmark_result_ids（二选一），与所选service匹配；
省略则保留原来的最近一组行为。单点选择只是导出视图，不新建SuiteResult事实。
不同契约结果分别导出，不能把旧字段语义强装进新列。

v2表保留测量/失败/未运行行、null为空和真实0，并附契约、单位与来源。
只有SLO通过、输入集合相同且缓存受控的点才能选“最佳”；条件不足明确不选择。
证据ZIP含选择的事实、BenchmarkResult、实际Artifact字节及manifest.json，每项都有SHA256/大小。
读出时再次验证Store哈希；篡改或超限报错。原指标JSON保留精度，XLSX仅为本地交付视图。
这是本地证据包，不是Cloud上传投影；没有在生成交付件时重新压测。
