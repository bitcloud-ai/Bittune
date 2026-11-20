import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile,readFile,cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	agentMarkerSatisfied,
	coreMarkerSatisfied,
	resolveIncomingAgentDistSha,
	replaceDirectory,
	writeInstallMarker,
	type InstallContext,
} from "../packages/bittune-runtime/src/cli/install/components.ts";

const sha = (content: string): string => createHash("sha256").update(content).digest("hex");

test("软件目录激活失败恢复旧版，成功替换保留备份及工作区数据",async()=>{
 const root=await mkdtemp(join(tmpdir(),"bittune-upgrade-"));
 try{
  const installed=join(root,"agent"),stage=join(root,"stage"),backup=join(root,"backups","previous");
  await mkdir(installed);await mkdir(stage);
  await writeFile(join(installed,"version"),"old");await writeFile(join(stage,"version"),"new");
  await writeFile(join(root,"account-data"),"keep");
  await assert.rejects(replaceDirectory(join(root,"missing-stage"),installed,()=>backup));
  assert.equal(await readFile(join(installed,"version"),"utf8"),"old");
  await replaceDirectory(stage,installed,()=>backup);
  assert.equal(await readFile(join(installed,"version"),"utf8"),"new");
  assert.equal(await readFile(join(backup,"version"),"utf8"),"old");
  assert.equal(await readFile(join(root,"account-data"),"utf8"),"keep");
 }finally{await rm(root,{recursive:true,force:true});}
});

function makeMarker(over: Partial<{ version: string; dist_sha256: string; core_wheel_sha256: string }> = {}): Parameters<typeof agentMarkerSatisfied>[0] {
	return { version: "0.1.0", dist_sha256: sha("installed"), ...over };
}

function makeContext(over: Partial<InstallContext>): InstallContext {
	return {
		installRoot: join(over.payloadPath ?? "/tmp", "..", "opt"),
		targetUser: "root",
		sourceKind: "bundle",
		payloadPath: "",
		appendLog: () => undefined,
		...over,
	};
}

test("agentMarkerSatisfied：marker、已装字节、入包字节三方必须一致", () => {
	const installed = sha("installed");
	assert.equal(agentMarkerSatisfied(undefined, installed, installed, "0.1.0"), false);
	assert.equal(agentMarkerSatisfied(makeMarker(), installed, installed, "0.1.0"), true);
	// 同版本重打包：入包哈希不同 -> 必须重装（用户报告的静默跳过场景）
	assert.equal(agentMarkerSatisfied(makeMarker(), installed, sha("rebuilt"), "0.1.0"), false);
	// 版本升级 -> 重装
	assert.equal(agentMarkerSatisfied(makeMarker(), installed, installed, "0.2.0"), false);
	// 已装文件被改动：marker 与已装不符 -> 重装
	assert.equal(agentMarkerSatisfied(makeMarker(), sha("tampered"), installed, "0.1.0"), false);
});

test("Core摘要仅在Core安装成功后记录，Agent升级不能提前跳过同版本Core更新", async () => {
	const wheelSha = sha("wheel-v2");
	assert.equal(coreMarkerSatisfied(undefined, wheelSha, true), false);
	assert.equal(coreMarkerSatisfied(makeMarker({ core_wheel_sha256: wheelSha }), wheelSha, true), true);
	assert.equal(coreMarkerSatisfied(makeMarker({ core_wheel_sha256: sha("wheel-v1") }), wheelSha, true), false);
	assert.equal(coreMarkerSatisfied(makeMarker({ core_wheel_sha256: wheelSha }), wheelSha, false), false);
 const root=await mkdtemp(join(tmpdir(),"bittune-core-marker-"));
 try{
  await mkdir(join(root,"agent"));
  await writeFile(join(root,"agent/.bittune-install.json"),JSON.stringify(makeMarker({core_wheel_sha256:wheelSha})));
  const ctx=makeContext({installRoot:root});
  await writeInstallMarker(ctx,{distSha:sha("new-agent")});
  const before=JSON.parse(await readFile(join(root,"agent/.bittune-install.json"),"utf8"));
  assert.equal(coreMarkerSatisfied(before,wheelSha,true),false);
  await writeInstallMarker(ctx,{coreWheelSha:wheelSha});
  const after=JSON.parse(await readFile(join(root,"agent/.bittune-install.json"),"utf8"));
  assert.equal(coreMarkerSatisfied(after,wheelSha,true),true);
  assert.equal(after.dist_sha256,before.dist_sha256);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("resolveIncomingAgentDistSha 同版本worker或技能更新也会改变安装摘要", async () => {
	const root = await mkdtemp(join(tmpdir(), "bittune-install-"));
	try {
		const distDir = join(root, "bundle", "agent", "dist");
		await mkdir(distDir, { recursive: true });
		const content = `bundled bittune dist ${Math.random()}`;
		await writeFile(join(distDir, "bittune.js"), content);
		await writeFile(join(distDir, "task-worker.js"), "worker");
		const ctx = makeContext({ sourceKind: "bundle", payloadPath: join(root, "bundle"), installRoot: join(root, "opt") });
		const original=await resolveIncomingAgentDistSha(ctx);
		assert.match(original,/^[a-f0-9]{64}$/);
		assert.equal(ctx.incomingAgentDistSha,original,"digest 必须被记忆到 ctx");
		await writeFile(join(distDir,"task-worker.js"),"new-worker");
		assert.notEqual(await resolveIncomingAgentDistSha({...ctx,incomingAgentDistSha:undefined}),ctx.incomingAgentDistSha,"worker-only更新也要重装");
		await writeFile(join(distDir,"task-worker.js"),"worker");
		await mkdir(join(root,"bundle/agent/skills/prepare"),{recursive:true});
		await writeFile(join(root,"bundle/agent/skills/prepare/run.sh"),"changed skill");
		assert.notEqual(await resolveIncomingAgentDistSha({...ctx,incomingAgentDistSha:undefined}),original,"仅技能改变也要重装");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolveIncomingAgentDistSha 网络包与离线目录对相同产品文件计算一致摘要", async () => {
	const root = await mkdtemp(join(tmpdir(), "bittune-install-"));
	try {
		const payloadDir = join(root, "payload");
		await mkdir(join(payloadDir, "package", "dist"), { recursive: true });
		const content = `tgz bittune dist ${Math.random()}`;
		await writeFile(join(payloadDir, "package", "dist", "bittune.js"), content);
		await writeFile(join(payloadDir, "package", "dist", "task-worker.js"), "worker");
		await mkdir(join(payloadDir,"package/skills/prepare"),{recursive:true});
		await writeFile(join(payloadDir,"package/skills/prepare/run.sh"),"skill");
		await writeFile(join(payloadDir,"package/package.json"),JSON.stringify({version:"0.1.0"}));
		await cp(join(payloadDir,"package"),join(root,"bundle/agent"),{recursive:true});
		const archive = join(root, "payload.tar.gz");
		execFileSync(process.platform === "win32" ? "tar.exe" : "tar", ["-czf", "payload.tar.gz", "-C", "payload", "package"], { cwd: root });
		const ctx = makeContext({ sourceKind: "network", payloadPath: archive, installRoot: join(root, "opt") });
		const expected=await resolveIncomingAgentDistSha(makeContext({sourceKind:"bundle",payloadPath:join(root,"bundle"),installRoot:join(root,"opt")}));
		assert.equal(await resolveIncomingAgentDistSha(ctx),expected);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
