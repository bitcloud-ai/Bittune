export function observedMetric(row:any,name:string):number|null {
 const value=(row.measurement?.metrics || row.metrics || {})[name];
 return typeof value==="number"&&Number.isFinite(value)?value:null;
}
export function accountingView(row:any,hours:number){
 const rate=observedMetric(row,"output_tokens_per_second");
 const projected=row.measurement_status==="complete"&&rate!==null&&rate>0&&Number.isFinite(hours)&&hours>0?rate*hours*3600:null;
 return {schema_version:"bittune-accounting-v1",measurement_status:row.measurement_status,slo_status:row.slo_status,observed:{input_tokens_total:observedMetric(row,"input_tokens_total"),output_tokens_total:observedMetric(row,"output_tokens_total"),total_requests:observedMetric(row,"total_requests"),success_requests:observedMetric(row,"success_requests"),duration_seconds:observedMetric(row,"duration_seconds"),output_tokens_per_second:rate,mean_ttft_ms:observedMetric(row,"mean_ttft_ms"),mean_tpot_ms:observedMetric(row,"mean_tpot_ms"),success_rate:observedMetric(row,"success_rate")},estimated:{hours,output_tokens:projected!==null&&Number.isFinite(projected)?projected:null},note:"实际Token仅统计成功请求；时长折算不是生产容量。"};
}
