"""Build explicitly unvalidated V2 prompts from reviewed campaign findings."""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SUITE=ROOT/'runs/20261019-allcases-discovery-v1'

COMMON='''V2 补充执行约定（与下文旧版通用要求冲突时，以这里为准；保留已声明工况，新增物理约定在逐题补充中明确标出）：
本轮服务器能力快照：指定venv中PyFluent 0.38.1、PyMechanical 0.13.3、numpy可用；rg、裸python命令、PyMAPDL、MAPDL reader、DPF、h5py、matplotlib和scipy不可用。系统脚本用python3，PyAnsys/numpy调用使用题面指定venv。不要反复调用已知缺失依赖；本轮绘图可选，数值CSV与原生结果优先。环境或服务器更换后重新验证这份快照。
1. 一次接收任务后自主完成，不等待中间确认。只在缺少影响物理正确性的必要输入、无可用许可证/工具链或预算不足时记录明确阻塞；禁止为避免提问而虚构参数。缺参数写needs_input.json，环境失败写issues.json，计算未收敛写INCOMPLETE，不把这些状态都写成PASS。
2. 启动前验证本题必需的可执行程序/模块/资产；可选命令缺失单独记录，不令整个探测脚本误报失败。先查询实际API/参数名和可选值再写设置，不连猜多个跨版本API路径。使用本题提供的Python解释器。
3. 求解前检查单位、实体/节点/边界选择数量、局部坐标轴、载荷合量及方向；选区为空或模糊时立即停止该阶段。输入资产只读，使用工作副本。首次失败和后续修复分别保留。
4. 第一次执行即创建results.json和issues.json的初始状态；每个阶段更新状态并保存checkpoint。保留最后60秒用于保存结果与报告，不以图形、动画或额外推导挤占求解预算。报告以必需指标和证据为主，不自行扩展本题之外的求解验证任务。
5. 只读取该单元/求解类型实际存在的自由度、结果集和结果项。任何被忽略/失败的GET命令都不能沿用上一次参数值。缺失数据写null并说明；不是在提取失败时填0。
6. 数值检查按物理类型区分：静力检查约束反力与载荷；轴对称使用正确的轴向平衡和环向应力关系；模态检查实际阶数、特征值收敛、振型/正交性或可靠的特征对残差，不把静力反力平衡当成模态验收门槛，也不从邻单元自行重建缺失质量矩阵行；瞬态守恒包含域内积累项。理论或实际近零的分母不得用于相对误差，使用明确特征尺度或报告绝对误差。
7. 结果文件先写完再生成SHA-256清单，清单排除自身和仍在变化的日志；最终再校验一次。Markdown中的LaTeX用raw字符串或正确转义，并拒绝非预期控制字符。精确文本编辑必须使用唯一上下文。APDL字符字面量可能截断为8字符，优先导出无表头数值再由Python写完整CSV表头；使用数组的VWRITE要显式限制向量长度，核对节点唯一性、行数和列数。
8. issues中分别统计physics_repairs、postprocess_repairs、tool_retries、environment_blocks、human_requests；另给出first_solver_attempt_success和first_end_to_end_attempt_success。工具探测失败不自动等于物理模型失败。每条问题都附实际日志/原始输出证据。
9. 提取、绘图、报告或校验失败，优先重新打开已有DB/RST或case/data修复该阶段；仅在物理设置、网格、求解或已保存结果无效时重新求解。明确记录“求解重试”和“仅重新后处理”，不要因CSV表头或哈希错误重跑昂贵计算。
10. Fluent CAD导入使用workspace内独立MW_TMPDIR、MWUSER_DIRECTORY和TMPDIR，并为导入单独设置阶段超时；这是本轮多个案例成功恢复的措施，不宣称已证实底层根因。只清理本任务拥有的进程。解析/proc/PID/stat时进程名可能含空格和括号，不得直接split后用固定索引取PID/PPID；优先使用启动时记录的PID和进程组。
11. 记录实际原生求解器进程的资源，而非只计Python启动器。Fluent/MPI可能脱离父进程或原进程组，必须说明采样覆盖范围；不能将漏采的RSS/CPU当作全求解成本。每阶段用已测耗时估算剩余工作，自适应后重新估算。截止前的预留时间只用于必需数值、状态、报告及关闭会话，不再追加可选绘图、重跑或复杂脚本改写。

'''
FIXES={
'A04':'''轴流风扇五点工况：每个背压点分别记录真实迭代数、残差、质量不平衡和最后100步工程量稳定性；2500步达到上限但未满足条件必须标为COMPLETED_UNCONVERGED。Fluent zone与postprocessing surface名称先通过get_state/allowed_values核对，不能将shadow zone直接作为surface。恢复计算时排除续算初始残差种子行并校验监控行数。退出前直接记录原生求解器资源和PID，PyFluent退出后确认Fluent/MPI进程消失；不要把退出码0当作收敛。转矩保留符号，轴功率明确P_input=-T_fluid*omega。\n''',
'A06':'''Fluent内置结构专用：允许并要求交付原生cas.h5/dat.h5及CSV，不强制MAPDL DB/RST/INP；必须在报告中声明格式。先读回固体zone材料，显式覆盖E=200GPa、rho=7850kg/m3、nu=0.3。切换flow/kw/structure方程后重新设置结构残差阈值并关闭自动提前停止，记录实际结构迭代数。Intrinsic FSI的operating pressure只加入一次，单列表压、环境压贡献和结构绝对压力；不得把非封闭界面环境压力合力当作气动力。边界zone名称和postprocessing surface名称分别核对，创建有效surface后再导出。原生节点反力不可用时写null，并提供应力积分近似及局限；不要把零数组解释为零反力。直接对Fluent启动器采集time/RSS，清理并确认所有自有原生进程。\n''',
'A07':'''本题是就绪性检查，不是求解题。必须首先确认物理定义：来流/速度、密度/黏度、湍流模型、边界条件、参考面积/长度、时间或稳态目标、收敛阈值及必需输出。现有STEP和MSH没有这些必要工况时，最多做有限时长的只读资产检查，立即写needs_input.json并结束；禁止启动Fluent网格读取后无限等待，也禁止凭文件名猜参数。资产检查预算不超过60秒；记录mesh/STEP文件大小、可读性和网格维度即可。\n''',
'A03':'''V2补充物理/数值定义：walls及其余实体壁面均为静止无滑移绝热壁、热通量0W/m²；这是对V1隐含热条件的显式补充。密度梯度以全域平均值归一化(scale-by-global-average)，不是最大值归一化；保持细化>0.5、粗化<0.45和最高2级。cell_registers先create再赋值，切换solver前保存meshing workflow，此后仅保留有效solver对象并关闭一次。网格质量用本版settings.mesh.quality。瞬态每次推进1步，在25的整数倍执行自适应并分别记录转移前后质量和单元数，按加密后耗时重新估算300步预算。20次内迭代仍未满足判据时记录未收敛，不静默增加上限或跳过自适应。完整周期尚未覆盖时波形/周期稳定指标写null；不得把域内质量积累检验通过当作瞬态残差收敛。原生Fluent程序从启动即加入time/timeout计量，不用Python启动器统计冒充全部资源。\n''',
'A02':'''V2纠正V1题面方向错误：本资产inlet在z=+2.088m、outlet在z=-2.088m，车头front在z≈0.944–1.044m、车尾rear在z≈0–0.209m。保持原资产边界名称和车头来流，入口速度向量明确(0,0,-30)m/s，流向为-Z，覆盖下文旧版“流向+Z”。官方脚本的force_vector=(0,0,1)是报告投影方向，不能据此推断来流为+Z。同时输出Fz和Cd_z=Fz/(0.5*rho*U²*Sref)的原始符号，以及约定沿来流的正阻力D=-Fz、Cd_drag=-Cd_z，禁止简单取绝对值而隐藏方向。面积保留0.11203202m²与半模型匹配，不额外乘2。初始化前导出inlet/outlet/front/rear包围盒和速度方向，明确两者一致后才求解。使用workspace内MW_TMPDIR、MWUSER_DIRECTORY、TMPDIR隔离导入；已有网格时从checkpoint恢复，当前版本不调用不存在的mesh.size。\n''',
'A01':'''V2补充物理约定（这是新版题面的显式约定，不冒充V1已给定条件）：wing_top、wing_bottom、wing_edge均为静止无滑移、绝热壁面，热通量0 W/m²；远场与对称面保持题面定义。进入CAD/网格前先检查能量方程所需热边界是否齐全。参考面积/弦长不明确时按原题允许只交付半翼实际升阻力N，系数写null及原因，不因此阻塞流场求解。每个案例为MWUSER_DIRECTORY与TMPDIR建立工作区内独立目录，禁止修改全局设置；为CADReader导入设置阶段超时并检查几何输出。记录该隔离措施曾恢复导入，但根因尚未证实。不得用Fluent启动成功代替CAD导入成功。缺少h5py等辅助读取器时使用原生导入报告确认单位/边界。顶层异常必须向外传播非零退出码，分别记录script_ok、stage_status和physical_acceptance。\n''',
'S09':'''Linux Mechanical embedding用已安装venv的mechanical-env启动，-p指Ansys版本安装根目录而非aisol子目录；只设置子进程环境。成功启动后不再探测未配置的gRPC路径。版本用App.version；只查询必要的公开属性，避免遍历所有InternalValue触发原生崩溃。崩溃工程有锁时保留证据，在新工程重新导入。内嵌脚本文件使用with open并close，.NET数值转换为Python int/float再序列化。导入后审核自动接触，最终活动接触必须恰为题定六组，按命名选择核验材料和接触源/目标；保留所有指定KEYOPT/RMODIF。先设置4步再填匹配长度的预紧表，逐步Load/Lock核对原生输入。第一步力控制的working-load反力通道可能为0，应从原生施加载荷取值；锁定步读约束反力/工作载荷，不能猜PRETS179的SMISC项。保存独立SHPP/CHECK网格检查、真实收敛、MPC重叠/过约束和薄层单元警告。MPC接触压力通道的0不代表无力传递；记录结果位置与平均方式。线弹性高应力不能用来断言材料屈服/强度通过。保持题定网格，不把未做网格研究写成网格独立。\n''',
'S08':'''自由循环模态专用：求解前逐对核对周期面角节点及中边节点经过扇区旋转后的坐标误差，不能仅凭CYCLIC命令顺序认定网格匹配；检查求解日志的映射约束警告。APDL数组避免UX/UY/UZ等保留字。输出每个结果集对应谐波、阶数、频率和简并配对，非零谐波的10个结果集可能只含5个不同频率；简并振型使用子空间比较。保留自由边界与题定1Hz起始频率，不为消除LANB病态性警告添加约束或改移频。单独报告病态性警告、频率网格变化、周期连续性与可测的特征对残差；自写积分的Rayleigh频率偏差不能冒充原生矩阵残差。循环结果的GET/VGET可能是未组合分量，必须说明基扇区/重复扇区、实虚部和全盘重构约定。没有独立参考或数值验收依据时标记精度未验证。\n''',
'S01':'''本题BEAM188专用预检：对沿全局+X的I→J连接，方向节点K取全局+Y侧时，应核验局部z与全局+Y、局部y与全局−Z对应，I截面高度沿局部z，XY弯曲绕截面强轴。SFBEAM面1正压力在此基底下对应全局−Y；不能凭面号名称猜方向。先核对实际基底、截面Iyy/Izz及最小载荷试验的反力/弯矩方向再进行完整求解。载荷平衡正确不能独自证明强弱轴正确。
''',
'S02':'''PLANE183结果提取：全节点导出位移，角节点导出可直接读取的应力；中边节点应力若需插值必须另标来源，不能GET失败后保留旧值。Kt_net与Kt_gross须给出各自分母及数值。右端总力只施加一次，记录耦合主节点与选区节点数。
''',
'S03':'''PLANE183轴对称输出：全节点位移仅含有效UX/UY；应力用角节点，SX为径向、SY为轴向、SZ为环向。r=4,6,8的输出点必须实际存在或明示插值。外壁径向应力用|SX|/内压或绝对误差；不要除以0。禁止把径向标量合力当作全圆筒全局X合力。无需另实现Q2/Q3有限元积分器作为交付前置条件。
''',
'S04':'''壳模型保留原题三组单元/网格，不为满足未声明的精度阈值擅自替换。分别记录各模型加载点带符号UY、约束节点唯一清单、反力和反力矩。每个约束节点恰好一行；用标量写反力或显式限制VWRITE数组长度。低阶粗网格与高阶细网格对理论参考的偏差应分开报告，不把两种单元套用同一个未冻结门槛。
''',
'S06':'''大变形求解保留NLGEOM及原始偏置。CNVTOL明确力/矩容差1e-4、L2范数和MINREF=1，记录实际收敛判据。反力只读取DLIST中实际约束的自由度，其他项null，并对照PRRSOL。BEAM188 SMISC按文档具体序号用ETABLE/PRETAB，不使用缺序号PRESOL,SMISC。SECR默认提取位置必须核对回显；不要给GET随意增加I/J或1/2参数并把列名当成位置证据。保留第一单元I/J两端完整PRESOL截面表，以该表核实最大/最小所在端，精确GET值只声明实际取到的端。最终验证用独立脚本并先做语法检查。
''',
'S07':'''模态专用输出：0–200Hz最多10阶，以实际提取/展开的阶数为准；区间内不足10阶的预期警告不是失败。导出实际UX/UY/UZ和ROTX/ROTY/ROTZ以及物理节点坐标。纯扭转中心线平移近零，使用对应转角计算MAC，不能用平移噪声做MAC。频率网格变化与MAC分别报告：MAC高不意味着频率已收敛；保持10/20单元比较，不暗中改变本轮网格定义。无预应力模态不实施静力反力验收，不要求从相邻单元重构固定端质量矩阵。
''',
}

def main():
    out=SUITE/'prompts-v2';out.mkdir(exist_ok=True)
    (out/'common.md').write_text(COMMON,encoding='utf-8')
    suite=json.loads((SUITE/'suite.json').read_text(encoding='utf-8'))
    manifest={'status':'DRAFT_NOT_RERUN','goal':'single-prompt autonomous execution; zero-repair success not yet demonstrated','cases':[]}
    manifest['new_physical_conventions']=[{'case_id':'A01','parameter':'wing thermal boundary','value':'stationary no-slip adiabatic walls; heat flux 0 W/m2','provenance':'Explicit V2 benchmark convention filling the observed V1 omission; consistent with observed Fluent default, not an explicit statement in the archived official script','changes_frozen_specification':True,'rerun_validation':False}]
    manifest['new_physical_conventions'].append({'case_id':'A02','parameter':'flow direction and signed drag reporting','value':'Flow -Z; inlet velocity (0,0,-30) m/s. Report both Fz/Cd_z and D=-Fz/Cd_drag=-Cd_z','provenance':'Observed asset inlet at z=+2.088m and outlet at z=-2.088m; archived tutorial only defines the report force_vector +Z, which V1 incorrectly interpreted as flow direction','changes_frozen_specification':True,'rerun_validation':False})
    manifest['new_physical_conventions'].append({'case_id':'A03','parameter':'wall thermal condition and density-gradient normalization','value':'Adiabatic no-slip walls, zero heat flux; scale-by-global-average density-gradient normalization','provenance':'Thermal choice makes the observed default explicit; global-average normalization matches the archived official tutorial','changes_frozen_specification':True,'rerun_validation':False})
    for item in suite['cases']:
        cid=item['id'];fix=FIXES.get(cid,'')
        if cid=='S09':fix+='位移最大值须标明原始Mechanical网格节点范围或包含求解器生成的预紧切分节点；两者分别导出最大值和节点ID。不能把预紧调整辅助自由度当作结构位移，也不能把仅原始网格节点的最大值无条件称为全模型最大值。\n'
        text=COMMON+fix+'\n以下为保留的物理题面与原始交付要求：\n\n'+(SUITE/cid/'prompt.md').read_text(encoding='utf-8')
        (out/(cid+'.md')).write_text(text,encoding='utf-8')
        manifest['cases'].append({'case_id':cid,'sha256':hashlib.sha256(text.encode()).hexdigest(),'case_specific_revision_reviewed':cid in FIXES,'validation':'NOT_RERUN','source_v1':str(SUITE/cid/'prompt.md')})
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['V2 评测提示词草案','',
    '状态：DRAFT_NOT_RERUN。根据V1实测问题修订，尚未复验，不能宣称保证一次成功。新运行必须使用独立目录/会话，保留V1输入与证据。','',
    '新增物理约定：A01/A03明确壁面绝热、零热通量；A03明确密度梯度按全域平均值归一化；A02保留资产坐标，将来流纠正为-Z，并分别报告有符号Fz/Cd_z与沿流向正阻力。上述补充不得追溯修改V1，V1/V2指标比较时需注明方向约定。','',
    '运行预算应在控制器与题面同步设置。当前草案保留V1预算；A02已暴露预算不足，复验前应评估相同预算的提示词对照，以及充分预算的数值收敛测试，不能把延长预算的效果全部归因于提示词。','',
    '| 案例 | 完整提示词 | 专用修改已整理 |','| --- | --- | --- |']
    for item in manifest['cases']:
        cid=item['case_id'];lines.append(f'| {cid} | [{cid}.md]({cid}.md) | {item["case_specific_revision_reviewed"]} |')
    lines+=['','[通用执行约定](common.md)；[状态、物理约定与SHA-256](manifest.json)。']
    (out/'README.md').write_text('\n'.join(lines),encoding='utf-8')
    print(out)

if __name__=='__main__':main()
