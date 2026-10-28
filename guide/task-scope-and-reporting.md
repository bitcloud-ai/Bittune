# 指定资源任务与大报告

默认调查模式保持原行为。需要禁止全局枚举、只操作选定资源时，由宿主提供任务范围文件：

```bash
BITTUNE_TASK_SCOPE_FILE=/absolute/path/task-scope.json bittune
```

示例（用已有记录中的真实ID替换示例值）：

```json
{
  "schema_version": 1,
  "allow_execution": false,
  "plan_ids": ["plan-existing"],
  "service_instance_ids": ["service-existing"],
  "record_ids": ["report-existing", "suite-existing"],
  "read_paths": []
}
```

Core启动时验证并固定配置；无效配置报错，不退回无限制模式。自然语言限制不会自动编译成配置，
必须显式启用。scope_hash用于核对范围；工具参数和“跳过确认”不能关闭门禁。

- 指定计划是允许的模型和精确镜像来源。允许执行时，派生计划必须继承这些身份；
  原计划校验、冻结确认、受管服务双归属门禁仍保留。
- 服务只允许get授权ID，禁止list。允许执行时，本会话新服务自动进入范围，Ready失败后仍可清理；
  实际写出的失败Run和Artifact也可回查。另一会话需显式配置既有服务ID。
- `allow_execution=false`禁止计划操作、服务启停和模型测量；仍允许归档读取、已有结果比较、本地报告/导出。
  它不是整个文件系统只读，Run与失败证据继续留存。
- `record_ids`选择允许读取/引用的已有归档，新写事实自动可读。继承选定报告可以复用其已有归档引用，
  这不会授权操作关联服务。inspect_records省略id时可在对应授权集合内检索事实（计划用plan_ids、服务用service_instance_ids、其它事实用record_ids），过滤和LIMIT均在集合内生效。
  空集合返回空列表；run/artifact仍需具体授权ID；读取结果不会扩大授权。不授权外部推理端点。
- 通用read只允许`read_paths`中的精确已有文件实路径，目录和受管配置/证据根不开放；edit/write关闭。
  Bash只开放系统提示列出的两条固定nvidia-smi占用查询。Docker、解释器、管道、包装命令及未知shell均拒绝。
  本模式不临时放宽镜像/模型准备权限，不注册investigate。

通用工具完成后会等待Core摄入，并在工具结果末尾追加`Bittune evidence`中的真实`run_id`和`artifact_refs`，
可用于inspect_records回读和报告引用。文件read不会额外复制文件正文到Artifact；有Run而无Artifact是正常情况。
归档失败保留原工具输出及警告，不返回虚构来源；staging写入成功但摄入失败时保留待处理文件。

这是产品工具门禁，不是针对恶意插件、管理员或其它进程的OS沙箱，也不改变历史执行结论。

第二引擎任务可由宿主增加`runtime_specs`（完整精确镜像身份）和`preparation_commands`（逐字匹配的准备命令）。
派生计划仍须继承授权模型，只能改用列表内的runtime；准备命令要求allow_execution=true，并沿用现有ask确认。
未配置时不开放额外镜像或shell，Agent不能自行扩展列表。

## 跨套件实验预算

允许执行的宿主配置可增加`experiment_budget`，例如：

```json
{
  "profile_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "max_suite_calls": 2,
  "max_points": 8,
  "max_requests": 512
}
```

示例hash为占位值，使用时替换为实际档案hash。此时只允许匹配hash的v2档案、`performance_sweep`和`package=short`；单点和其它测量intent拒绝。
确认前预检不扣额，实际开始时按档案整套上限预留到Run中；失败、取消或中断不退额、不自动补跑。
原套件预算继续限制每个测量点（含确认）；预热、Ready及探活不计正式请求。
相同Core Store与scope_hash跨重启累计；这是已有单Core执行路径的预算，不是多Core共享库并发配额。
未配置此字段时保持原有行为。预留总额与实际执行数量分别报告。

`compare_results`使用`suite_points`且`record=true`时，也会创建可按ID回查的Experiment，
保留套件工作点（含传入的repeat）、原始BenchmarkResult锚点与比较结论；不能签字的比较不创建实验。
不归档时省略record或设为false，比较仍返回原有结果。

## 完整套件报告

向`write_report`传紧凑选择，Core遍历全部行，保留重复、确认、失败与未测状态：

```json
{
  "title": "已有套件报告",
  "narrative": "归档复核，无新增测量。",
  "conclusion": "以Core覆盖及来源为准。",
  "suite_selections": [{
    "suite_result_id": "suite-existing",
    "metrics": ["total_requests", "duration_seconds", "requests_per_second", "goodput_req_per_s", "p99_ttft_ms"]
  }]
}
```

不要同时传手写suite_claims。测量状态、聚合SLO和Core决定单列，不能因measured称SLO通过。
有来源的不可用值保留原因、不补0；缺数值且无不可用来源时拒绝报告。未测行不变成实测指标。

## 修订已有报告

```json
{
  "based_on_report_id": "report-existing",
  "title": "报告修订",
  "narrative": "纠正解释，保留指标引用。",
  "conclusion": "本次只修订报告，不重测。"
}
```

Core保留原报告全部结构化引用，从Canonical重新取数，旧报告/Artifact不改。
禁止重传references或claims数组覆盖来源，避免110条变27条。
完整报告留在事实库和Markdown Artifact；紧凑模式只向Agent返回ID、Artifact与覆盖摘要。

`coverage`记录实际数量、引用身份哈希、套件行/指标与来源hash；继承另记录原报告ID和content_hash。
手写claims兼容但标为explicit_subset，不宣称全套件覆盖。继承只保证保留来源已有引用，
不会把旧子集变完整；需要全套件表时用suite_selections。覆盖计数不保证任意叙述正确，仍须核对正式指标及证据。
