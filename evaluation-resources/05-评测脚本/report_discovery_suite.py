"""Build a live diagnostic report and traceable issue inventory from collected runs."""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SUITE=ROOT/'runs/20261019-allcases-discovery-v1'

def read(p,default=None):
    if not p.exists():return default
    return json.loads(p.read_text(encoding='utf-8'))

def link(label,p):return f'[{label}](<{p.resolve().as_posix()}>)'

def main():
    spec=read(SUITE/'suite.json');state=read(SUITE/'remote-status.json',{})
    incident=read(SUITE/'transport-incident.json',{})
    status_text='全部结束' if state.get('finished') else f'进行中，当前 {state.get("active","准备中")}'
    if incident.get('status')=='AWAITING_NETWORK_RESTORATION':status_text='SSH/网络中断，未回收案例的当前远程状态未知；最后观察到A04运行'
    lines=['全案例诊断评测记录\n',f'批次：{spec["suite_id"]}。执行状态：'+status_text+'。\n',
    '目的：逐例定位人工介入点、参数错误、API/环境问题及产物缺失，形成下一版 Prompt。本轮是当前部署的诊断运行，不是跨版本正式排行榜。所有仿真在 SSH 服务器 leadhk01 执行。\n',
    '单条 Prompt 自主完成与首次无修复完成分别统计。Agent 声称完成、原生文件可重开、内部收敛、独立精度通过分别记录；未核验不记为通过。\n',
    '| 案例 | Agent 最终状态 | 用时 s | 工具错误 | 首次无修复（自报） | 修复次数（自报） | 估算 USD | 独立复核 |','| --- | --- | --- | --- | --- | --- | --- | --- |']
    issues=[];complete=[]
    for case in spec['cases']:
        cid=case['id'];r=SUITE/cid;m=read(r/'metrics.json')
        if not m:
            pending='远程状态待恢复确认' if incident.get('status')=='AWAITING_NETWORK_RESTORATION' else ('运行中' if state.get('active')==cid else '待运行')
            lines.append(f'| {cid} {case["title"]} | '+pending+' | — | — | — | — | — | — |');continue
        complete.append(m)
        own=m.get('agent_reported_issues') or {}
        ownrows=own.get('issues',[]) if isinstance(own,dict) else own
        for i,x in enumerate(ownrows):issues.append({'id':f'{cid}-AGENT-{i+1:02d}','case_id':cid,'reported_by':'agent','independently_reviewed':False,**x})
        review=read(r/'review.json',{})
        for i,x in enumerate(review.get('review_findings',[])):issues.append({'id':f'{cid}-REVIEW-{i+1:02d}','case_id':cid,'reported_by':'independent_evaluator','independently_reviewed':True,**x})
        wall=m.get('agent_wall_seconds');cost=m.get('runtime_estimated_cost_usd')
        wall_text=f'{wall:.2f}' if wall is not None else (f'{m["controller_wall_seconds"]:.2f}（控制器）' if m.get('controller_wall_seconds') is not None else '未测')
        cost_text=f'{cost:.6f}' if cost is not None else (f'{m["event_estimated_cost_usd"]:.6f}（已观测事件）' if m.get('event_estimated_cost_usd') is not None else '未知')
        status=str(m['agent_reported_status'] or m.get('evaluator_status') or m['execution'].get('controller_error') or '缺少结果')
        if m['execution'].get('timed_out'):status+=' / 控制器超时'
        lines.append('| '+ ' | '.join([cid+' '+case['title'],status,wall_text,str(m['tool_error_count']),str(own.get('first_attempt_success')) if isinstance(own,dict) else '未报',str(own.get('repair_count')) if isinstance(own,dict) else '未报',cost_text,m['independent_accuracy_status']])+' |')
    human=sum(m.get('human_interventions') or 0 for m in complete)
    followups=sum(m.get('controller_followups') or 0 for m in complete)
    interactive=sum(m['execution'].get('interactive_request_count') or 0 for m in complete)
    first=sum((m.get('agent_reported_issues') or {}).get('first_attempt_success') is True for m in complete)
    needs=[m['case_id'] for m in complete if m['execution'].get('needs_input_artifact') or m.get('agent_reported_status')=='NEEDS_INPUT' or 'MISSING_PHYSICAL_DEFINITION' in str(m.get('independent_accuracy_status',''))]
    lines+=['',f'已回收 {len(complete)}/{len(spec["cases"])} 项。累计已观测模型估算费用 ${sum(m.get("runtime_estimated_cost_usd") if m.get("runtime_estimated_cost_usd") is not None else m.get("event_estimated_cost_usd",0) for m in complete):.6f}；累计已观测 Token {sum(m["tokens"]["totalTokens"] for m in complete):,}。超时案例缺少最终会话统计，使用已完成消息事件的部分估算，可能遗漏中断请求。费用未核对账单，独立复核与编排开销不包含在 Agent 会话费用中。\n',
    f'运行中人工介入 {human} 次；控制器追加提示 {followups} 次；交互请求事件 {interactive} 次。首次无修复成功（Agent自报）{first}/{len(complete)}。这些计数不把评测前准备、评测后的独立审阅算作运行内干预，也不能把 NEEDS_INPUT 算作仿真完成。\n',
    '已输出待补输入的案例：'+('、'.join(needs) if needs else '目前无')+'。控制器没有收到交互弹窗不代表物理输入完整，以结果状态和needs_input.json共同判断。\n',
    '总Token含缓存读取，不能用总Token乘单一单价推算费用。RSS来自采样进程树，可能重复计算共享页，也可能遗漏脱离父进程的Fluent/MPI；Python启动器外层GNU-time不必然包含原生求解器。原始计时另存于各例指标，未实现完整统一资源计量。独立复核可能与下一例运行重叠，本轮耗时不用于严格版本性能排名。\n',
    '本轮有 13 个完整候选案例及 A07 储备模型。A07 缺少物理工况，要求只做就绪检查并输出 NEEDS_INPUT；它不能算作仿真成功。CFD 教程不是已收敛的基准真值，不能把结果产出或进程退出 0 当作精度通过。\n',
    '**已记录的问题**\n']
    verification=read(SUITE/'campaign-verification.json',{})
    if verification.get('same_recorded_runtime_fingerprint') is False:
        lines.append('部署指纹检查发现运行间差异，不能把本轮全部案例视为完全相同的冻结部署。详见campaign-verification.json中的runtime_fingerprint_differences；差异的成因及对行为的影响尚未确认。')
        for diff in verification.get('runtime_fingerprint_differences',[]):
            lines.append(f'- {diff["case_id"]} 相对 {diff["baseline_case_id"]}：新增文件 {diff["added_files"]}；删除文件 {diff["removed_files"]}；改动文件 {diff["changed_files"]}；运行配置差异 {diff["runtime_fields_changed"]}。')
    for x in issues:
        text=x.get('symptom') or x.get('finding') or '详见原始记录'
        remedy=x.get('prompt_v2_suggestion') or x.get('v2') or '待审阅'
        lines.append(f'- {x["id"]}：{text} 下一版建议：{remedy}')
    lines+=['\n**下一轮 Prompt 与验收**\n',
    'V2 草案已按本轮实际问题补充环境快照、求解前参数/选区检查、受支持的结果项、分阶段重试、数值验收及产物完整性要求。它尚未重新运行验证；不能据此声称下一轮保证一次成功。物理必要输入缺失仍应阻塞。\n',
    '- '+link('V2 通用补充',SUITE/'prompts-v2/common.md'),
    '- '+link('逐案例 V2 状态与哈希',SUITE/'prompts-v2/manifest.json'),
    '\n下一轮应在新workspace和新会话重新执行V2，固定部署、模型、求解器、输入、预算及验收阈值；分别比较人工请求率、首次求解成功率、首次端到端成功率、修复次数、数值验收与必需产物完整率。先用本轮作为诊断基线，完成收敛真值与阈值冻结后再用于版本排名。\n',
    '**证据与口径**\n',
    '- '+link('预检发现（与运行中发现分开）',SUITE/'preflight-findings.json'),
    '- '+link('机器指标索引',SUITE/'metrics-index.json'),
    '- '+link('完整问题索引',SUITE/'issues-index.json'),
    '\n每例目录中的 prompt.md、run-config.json、freeze.json 为冻结输入；metrics.json 为控制器测量；collected/workspace/issues.json 为 Agent 自报问题；review.json 为独立审阅。原始工具错误保留在 metrics.json 的 tool_errors，不能自动等价为物理建模失败。\n']
    for m in complete:
        r=SUITE/m['case_id']
        lines.append('- '+m['case_id']+'：'+link('完整指标',r/'metrics.json')+'；'+link('实际 Prompt',r/'prompt.md')+'；'+link('Agent 原始报告',r/'collected/workspace/report.md'))
    (SUITE/'issues-index.json').write_text(json.dumps(issues,ensure_ascii=False,indent=2),encoding='utf-8')
    (SUITE/'诊断评测报告.md').write_text('\n'.join(lines),encoding='utf-8')
    print(json.dumps({'collected':len(complete),'issues':len(issues),'finished':state.get('finished',False)}))

if __name__=='__main__':main()
