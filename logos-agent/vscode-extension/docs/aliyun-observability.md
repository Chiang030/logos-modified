# LOGOS 接入阿里云 Agent 观测

LOGOS 使用独立的 Pi RPC 进程，并指定 `--no-extensions`。Pilot 自动修改全局 Pi 的 `settings.json` 不足以接入 LOGOS；插件通过显式 `-e` 参数加载已安装的官方 Pilot 扩展。无需另外安装 Pi CLI，也无需在 Windows 上安装 nvm。

## Windows 安装

在 PowerShell 中运行官方安装器。它会安装自己的 Node.js 22，不改变 LOGOS 的内置 Node.js。
License Key 在提示时输入；不要写入仓库、VS Code 工作区设置或打包产物。

```powershell
$installer = Join-Path $env:TEMP 'loongsuite-pilot-installer.ps1'
Invoke-WebRequest 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1' -OutFile $installer
$license = Read-Host 'CMS License Key' -AsSecureString
$credential = New-Object System.Management.Automation.PSCredential('cms', $license)
& $installer install `
  -Agents 'pi-coding-agent' `
  -CollectLog 'false' `
  -CollectTrace 'true' `
  -CmsLicenseKey $credential.GetNetworkCredential().Password `
  -CmsEndpoint 'https://YOUR-PROJECT.YOUR-REGION.log.aliyuncs.com/apm/trace/opentelemetry' `
  -CmsWorkspace 'YOUR-WORKSPACE' `
  -ServiceNamePrefix 'ai-coding-agent'
Remove-Variable license,credential
```

替换 Endpoint 和 Workspace 为阿里云控制台提供的值。`-Agents` 限定采集 Pi。
Pilot 将接入凭据保存在用户目录下的 `.loongsuite-pilot/config.json`；LOGOS 不复制密钥。

## 启用 LOGOS

安装包含此适配的 VSIX，在 VS Code 的**用户设置**启用：

```json
{
  "logos.observability.enabled": true
}
```

自定义 Pilot 安装目录时，设置 `logos.observability.pilotDataDirectory` 为绝对路径。
留空使用用户目录下的 `.loongsuite-pilot`。这两项是应用级设置，不接受工作区覆盖。
执行 **LOGOS: Restart Runtime** 后生效。

Pilot 扩展在本地写入事件 JSONL，由后台采集器转换并发送 Trace。
`CollectLog=false` 关闭云端 Log 导出，不代表禁止本地事件文件或 Trace 中的内容采集；内容是否包含提示词、模型响应及工具参数由 Pilot 的配置决定。
平台中使用 Pi Coding Agent 分类，按会话 ID 或 `agent.pi-coding-agent.cwd` 区分 LOGOS 工作区。
缺少 Pilot 文件时，LOGOS 仍可使用，并在 **输出 → LOGOS** 显示观测未启用的原因。

## 验证

新终端中运行（PATH 尚未刷新时，用完整路径）：

```powershell
& "$env:USERPROFILE/.local/bin/loongsuite-pilot.cmd" status
& "$env:USERPROFILE/.local/bin/loongsuite-pilot.cmd" info
Get-ChildItem "$env:USERPROFILE/.loongsuite-pilot/logs/pi-coding-agent"
```

在 LOGOS 中完成一轮对话，然后检查阿里云工作空间中的新 Trace。
启动成功、扩展加载、本地 JSONL、导出成功、云端页面可查询是不同的验证层级；仅 `status` 为运行中不能证明云端接入成功。

开发者可在插件目录运行 `npm run smoke:runtime -- --with-pilot`：使用本地模拟模型及完整的内置 Pi，验证隔离配置、会话和官方扩展的 `llm.request` / `llm.response` 事件。该命令要求 Pilot 已安装，并会产生测试 Trace；不调用付费模型。

若本地事件正常但云端无 Trace，检查 `.loongsuite-pilot/logs/loongsuite-pilot-service.log.*` 中的 `Export failed`，以及 `logs/metric_alarm/pilot-flusher-metrics-*.jsonl` 的 `out_entries` 和 `failed_entries`。若域名被 VPN 的 Fake-IP DNS 解析为 `198.18.*`，且出现 TLS 握手中断，关闭 VPN 或为接收域名配置直连后重新验证；不要关闭 TLS 证书校验。

## 升级与卸载

重新下载上面的官方安装器后：

```powershell
& $installer upgrade
# 卸载前把 logos.observability.enabled 设置为 false，并重启 LOGOS。
& $installer uninstall
```

默认卸载保留数据；只有确实需要清除配置和本地数据时才使用 `uninstall -Purge`。

参考：[阿里云接入文档](https://help.aliyun.com/document_detail/2839063.html)、[LoongSuite Pilot 源码](https://github.com/alibaba/loongsuite-pilot)。
