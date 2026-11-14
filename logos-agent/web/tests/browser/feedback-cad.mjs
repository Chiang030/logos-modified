// Real browser interactions with mock API responses, no live users or models.
import { readFile } from 'node:fs/promises';
export default async function verifyFeedbackCad(page, origin, fixture, screenshot) {
  const stl = await readFile(fixture);
  const failures = [], submissions = [];
  let downloadFailure = false;
  page.on('pageerror', error => failures.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    let data = {};
    if(url.pathname === '/api/bootstrap') data={user:{id:'alice',name:'验证用户',admin:true},csrf:'fixture',previewEnabled:false,version:'test',executionReady:true};
    else if(url.pathname === '/api/projects') data={projects:[{id:'case',name:'STEP 验证项目',directory:'case'}]};
    else if(url.pathname === '/api/demos') {
      if(request.method()==='POST') data={project:{id:'case',name:'STEP 验证项目',directory:'case'}};
      else data={demos:[{id:'kicad-led',name:'KiCad · 5V LED 小板',summary:'ERC / DRC / STEP 已验证',limits:'演示封装，不是量产认证',prompt:'阅读验证记录后重跑'}]};
    }
    else if(url.pathname === '/api/leaderboards') data={usageMetric:'近30天有效活跃天数',feedbackMetric:'近30天已受理反馈',usage:[{name:'验证用户',count:3}],feedback:[{name:'验证用户',count:1}]};
    else if(url.pathname === '/api/feedback') {
      if(request.method()==='POST') { submissions.push(request.postDataJSON()); data={item:{id:'feedback'}}; }
      else data={items:[],hasMore:false};
    }
    else if(url.pathname === '/api/files') data={entries:[{name:'电路板.step',directory:false,size:2000,modified:0}]};
    else if(url.pathname === '/api/workspace') data={managed:false,studies:[]};
    else if(url.pathname === '/api/models') data={models:[],ready:true};
    else if(url.pathname === '/api/sessions') data={sessions:[]};
    else if(url.pathname === '/api/cad-preview') { await route.fulfill({contentType:'model/stl',body:stl}); return; }
    else if(url.pathname === '/api/file') {
      if(downloadFailure) { await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'文件不存在或不可访问'})}); return; }
      await route.fulfill({contentType:'application/octet-stream',headers:{'Content-Disposition':"attachment; filename*=UTF-8''%E7%94%B5%E8%B7%AF%E6%9D%BF.step"},body:'ISO-10303-21;\nEND-ISO-10303-21;'}); return;
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(origin);
  await page.getByRole('heading',{name:'社区排行榜'}).waitFor();
  await page.getByRole('heading',{name:'使用榜',exact:true}).waitFor();
  await page.getByRole('button',{name:'问题 / 需求反馈',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'问题与需求反馈'});
  await dialog.getByLabel('标题',{exact:true}).fill('STEP 下载反馈');
  await dialog.getByLabel('描述',{exact:true}).fill('复现：点击下载。期望：得到可打开的 STEP 文件。');
  await dialog.getByRole('button',{name:'提交反馈',exact:true}).click();
  await dialog.getByRole('status').getByText('反馈已提交，审核状态可在下方查看。').waitFor();
  if(submissions.length!==1 || submissions[0].kind!=='bug' || submissions[0].session || submissions[0].project) throw new Error('Feedback submission unexpectedly copied context');
  await page.getByRole('button',{name:'关闭反馈'}).click();
  await page.getByRole('button',{name:'创建个人示例项目',exact:true}).click();
  await page.locator('.file-list').getByRole('button',{name:'电路板.step',exact:false}).click();
  await page.getByRole('button',{name:'生成 3D 预览',exact:true}).click();
  await page.waitForFunction(()=>{const button=document.querySelector('.model-actions button'); return button && !button.disabled;});
  const download = page.waitForEvent('download');
  await page.getByRole('button',{name:'下载原文件',exact:true}).click();
  const saved=await download;
  if(saved.suggestedFilename()!=='电路板.step') throw new Error('Download filename corrupted: '+saved.suggestedFilename());
  if(await saved.failure()) throw new Error('Download failed');
  downloadFailure=true;
  await page.getByRole('button',{name:'下载原文件',exact:true}).click();
  await page.getByRole('alert').getByText('文件不存在或不可访问',{exact:true}).waitFor();
  if(new URL(page.url()).origin!==origin) throw new Error('Download error navigated away from workbench');
  if(screenshot) await page.screenshot({path:screenshot,fullPage:true});
  if(failures.length) throw new Error(failures.join('\n'));
  return {feedback:true,leaderboards:true,demoImport:true,stepWebGL:true,downloadName:saved.suggestedFilename(),downloadFailureVisible:true};
}
