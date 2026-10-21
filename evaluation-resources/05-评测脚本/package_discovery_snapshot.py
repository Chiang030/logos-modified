"""Package the diagnostic scripts and compact evidence; never include solver payloads."""
import ast
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / 'runs/20261019-allcases-discovery-v1'


def main():
    files = {}

    def add(path):
        if not path.is_file():
            return
        name = path.relative_to(ROOT).as_posix()
        data = path.read_bytes()
        if path.suffix == '.py':
            ast.parse(data.decode('utf-8'), filename=name)
        elif path.suffix == '.json':
            json.loads(data)
        elif path.suffix == '.md':
            # Reports link to local evidence, some deliberately excluded below.
            import os
            relative_root = Path(os.path.relpath(ROOT, path.parent)).as_posix()
            data = data.decode('utf-8').replace(ROOT.as_posix(), relative_root).encode('utf-8')
        files[name] = data

    names = [
        'prepare_discovery_suite.py', 'deploy_discovery_suite.py',
        'discovery_suite_worker.py', 'run_remote_benchmark.py',
        'collect_discovery_suite.py', 'inspect_discovery_live.py',
        'report_discovery_suite.py', 'summarize_discovery_lessons.py',
        'build_discovery_prompt_v2.py', 'verify_discovery_campaign.py',
        'audit_discovery_structures.py', 'audit_discovery_fluent.py',
        'run_discovery_cfd_audit.py', 'check_ahmed_monitors.py',
        'check_nozzle_monitors.py', 'resume_discovery_collection.py',
        'resume_discovery_pending.py', 'finalize_discovery_reviews.py',
        'package_discovery_snapshot.py',
    ]
    for name in names:
        add(ROOT / 'scripts' / name)
    for name in ['cases.json', 'model-assets.json', 'sources.json']:
        add(ROOT / name)
    for name in ['suite.json', 'remote-status.json', 'transport-incident.json',
                 'metrics-index.json', 'issues-index.json', 'campaign-verification.json',
                 'preflight-findings.json', 'environment.json', 'official-source-hashes.json',
                 'run_discovery_case.py', '诊断评测报告.md', '下一轮Prompt修改建议.md']:
        add(SUITE / name)
    for path in (SUITE / 'prompts-v2').iterdir():
        if path.suffix in ['.md', '.json']:
            add(path)
    spec = json.loads((SUITE / 'suite.json').read_text(encoding='utf-8'))
    for case in spec['cases']:
        folder = SUITE / case['id']
        for name in ['prompt.md', 'run-config.json', 'freeze.json', 'metrics.json',
                     'review.json', 'monitor-review.json', 'transfer-verification.json',
                     'archive-transfer-verification.json', 'evaluator-issues.json']:
            add(folder / name)
    files['README.md'] = '''# Logos 全案例诊断评测快照

本包保存当前诊断脚本、14项冻结V1题面、已回收11项的指标/独立审阅、问题清单和未复验的V2草案。
当前SSH网络中断，A04/A06/A07远程状态未知；详见runs/20261019-allcases-discovery-v1/transport-incident.json。
这是当前批次的可审阅快照，不是已完成的全套结果或跨版本排行榜。

## 阅读

- runs/20261019-allcases-discovery-v1/诊断评测报告.md：结果与限制。
- 同目录metrics-index.json及各案例metrics.json：耗时、工具、Token、费用、资源和物理指标。
- 同目录issues-index.json、各案例review.json：Agent自报与独立复核，含评测器自身问题。
- 同目录下一轮Prompt修改建议.md、prompts-v2/：修改依据与完整草案，DRAFT_NOT_RERUN。
- campaign-verification.json：已回收文件校验及A03新增技能导致的运行指纹差异。

## 脚本与运行限制

本地需要Python 3.10+、OpenSSH；求解需要服务器上的现有Logos、Ansys及许可证。
脚本中的批次ID、路径、预算和主机为本次实际配置，并非通用参数化发行版。
恢复连接后先读取远端status.json和本批次进程，再确定是否需要续跑。
discovery_suite_worker.py没有断点恢复：直接重启会从头执行并重写状态。
prepare/deploy脚本也不得在本轮目录直接重跑。新一轮必须使用新目录、会话与冻结配置。
V2物理补充和预算变化必须披露，不能追溯替换本轮V1输入。
本轮未冻结完全相同的部署，不宜用于严格版本排名；数值未收敛不因退出码0而通过。

包内不含模型大文件、原生求解结果、完整RPC轨迹、独立复核原始输出、Logos安装或许可证。
因此离线可审阅汇总，但不能只凭本包重算所有指标或独立验证原始结果；部分证据链接需要原工作区。
包中不收录.env、SSH配置、私钥或认证文件。MANIFEST.sha256校验的是包内快照文件。
'''.encode('utf-8')
    files['MANIFEST.sha256'] = ''.join(
        f'{hashlib.sha256(data).hexdigest()}  {name}\n'
        for name, data in sorted(files.items())).encode('utf-8')
    output = ROOT / 'dist/logos-allcases-discovery-partial-20261019.zip'
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            archive.writestr(name, data)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        for name, data in files.items():
            assert archive.read(name) == data
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(f'{digest}  {output.name}\n', encoding='ascii')
    print(json.dumps({'path': str(output), 'files': len(files),
                      'bytes': output.stat().st_size, 'sha256': digest}, ensure_ascii=False))


if __name__ == '__main__':
    main()
