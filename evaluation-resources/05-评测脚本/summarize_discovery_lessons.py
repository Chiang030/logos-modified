"""Build actionable prompt changes from observed and independently reviewed evidence."""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SUITE=ROOT/'runs/20261019-allcases-discovery-v1'

def read(p,default=None):
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else default

def main():
    suite=read(SUITE/'suite.json')
    lines=['下一轮基准评测 Prompt 修改建议','',
    '本轮以冻结的V1提示驱动当前部署的Logos，在leadhk01实际运行。运行内不追加提示；本文件根据保留的日志、Agent问题记录及独立结果复核整理。V2为草案，未重新运行，尚不能证明零修复或必然一次完成。','',
    '一次接收任务自主完成允许自动修复；首次端到端成功要求无需修复。这两个指标必须分开。NEEDS_INPUT、环境阻塞、未收敛、部分交付均不算仿真通过。','',
    '通用修改：','',
    '1. 题面给出单位、几何/网格、物性、载荷/边界、工况、采样定义及必需产物；近零参考量规定绝对误差或特征尺度。模态、静力、瞬态使用不同验收公式。',
    '2. 使用启动前实测的环境清单和版本匹配API，不重复猜测缺失依赖、参数或接口。可选绘图依赖缺失不能阻断数值交付。',
    '3. 求解前核对实体/节点选择、坐标轴、载荷合量、活动接触与周期配对。任何空选区或被忽略的命令必须显式处理。',
    '4. 从第一阶段开始维护results/issues/checkpoint。求解、后处理、报告可独立重试；后处理错误优先重开已有原生结果。',
    '5. 数值CSV优先使用稳定的数值导出加Python表头；校验维度、唯一节点、实际结果集和缺失值。所有写入结束后才生成哈希。',
    '6. 分开记录物理修复、后处理修复、工具重试、环境阻塞和人工请求。退出码、求解器收敛、工程量稳定、独立精度四项分别报告。','',
    '应由评测器落实：隔离工作目录和会话、SSH执行、固定版本与输入哈希、进程超时及定向清理、日志/Token/费用采集、传输校验、独立评分。提示词中的访问约定不等于操作系统隔离。','',
    '必须在下一轮前冻结的前提：A07的真实工况与参考定义；CFD收敛真值及容差；循环模态数值警告的验收依据；各案例预算。不得以虚构参数或放宽阈值换取成功率。','',
    '| 案例 | 实际发现 / 复核结论 | 下一版修改 |','| --- | --- | --- |']
    verification=read(SUITE/'campaign-verification.json',{})
    if verification.get('same_recorded_runtime_fingerprint') is False:
        lines.insert(lines.index('| 案例 | 实际发现 / 复核结论 | 下一版修改 |'), '部署冻结补充：本轮检测到案例间运行指纹不同，差异详见campaign-verification.json。下一轮使用独立、固定的部署副本，逐例启动前比较启动器、系统提示、扩展、技能清单及内容哈希；出现漂移时记录并中止正式版本比较，不仅依赖相同模型名称。此项由评测编排器落实。\n')
    reviewed=0
    for case in suite['cases']:
        r=SUITE/case['id'];rev=read(r/'review.json')
        if not rev:
            lines.append(f'| {case["id"]} | 尚未完成独立审阅 | 待本轮证据补充 |');continue
        reviewed+=1
        for finding in rev.get('review_findings',[]):
            row=[case['id'],finding.get('finding',''),finding.get('v2','')]
            lines.append('| '+' | '.join(str(s).replace('|','/').replace('\n',' ') for s in row)+' |')
    lines+=['',f'已审阅 {reviewed}/{len(suite["cases"])} 项。完整证据保留在各例review.json、metrics.json及collected目录。','',
    'V2复验方案：在新目录/会话使用相同输入及已冻结物理定义运行全部案例，不向Agent提供本轮输出或真值。先比较人工请求率与必需交付完成率，再比较首次求解/端到端成功率、修复次数、耗时、费用和独立数值指标。对失败保留原日志，禁止补写成功。只有V2实际复验通过的项目才能宣称改进有效。']
    (SUITE/'下一轮Prompt修改建议.md').write_text('\n'.join(lines),encoding='utf-8')
    print(f'reviewed {reviewed}/{len(suite["cases"])}')

if __name__=='__main__':main()
