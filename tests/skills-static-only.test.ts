import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { resolveProductSkillsDir } from "../packages/bittune-runtime/src/bittune.ts";
import { CONFIG_DIR_NAME } from "../packages/bittune-runtime/src/config.ts";
import { DefaultPackageManager } from "../packages/bittune-runtime/src/core/package-manager.ts";
import { DefaultResourceLoader } from "../packages/bittune-runtime/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/bittune-runtime/src/core/settings-manager.ts";
import { buildSystemPrompt } from "../packages/bittune-runtime/src/core/system-prompt.ts";
import { stripFrontmatter } from "../packages/bittune-runtime/src/utils/frontmatter.ts";
import { COPY } from "../packages/bittune-runtime/src/harness/tui/copy.ts";

const PRODUCT_SKILLS_DIR = resolveProductSkillsDir();

async function withTempDirs<T>(fn: (dirs: { cwd: string; agentDir: string }) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "bittune-skills-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	try {
		return await fn({ cwd, agentDir });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function loadProductSkills(agentDir: string, cwd: string, skillPaths: string[]) {
	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalSkillPaths: skillPaths,
		noSkills: true,
		staticOnly: true,
		systemPrompt: "custom",
	});
	await loader.reload();
	return { loader, settingsManager };
}

test("skills-static-only: 产品 additionalSkillPaths 进入 prompt，用户目录 Skill 不出现", async () => {
	await withTempDirs(async ({ cwd, agentDir }) => {
		await mkdir(join(agentDir, "skills", "user-fake"), { recursive: true });
		await writeFile(
			join(agentDir, "skills", "user-fake", "SKILL.md"),
			"---\nname: user-fake\ndescription: 不该出现的用户 Skill\n---\n\n不要加载。\n",
		);
		await mkdir(join(cwd, CONFIG_DIR_NAME, "skills", "project-fake"), { recursive: true });
		await writeFile(
			join(cwd, CONFIG_DIR_NAME, "skills", "project-fake", "SKILL.md"),
			"---\nname: project-fake\ndescription: 不该出现的项目 Skill\n---\n\n不要加载。\n",
		);

		const { loader } = await loadProductSkills(agentDir, cwd, [PRODUCT_SKILLS_DIR]);
		const skills = loader.getSkills().skills;
		const names = skills.map((skill) => skill.name).sort();
		assert.deepEqual(names, ["benchmark-suite", "prepare-engine", "prepare-model"]);
		assert.equal(skills.find((skill) => skill.name === "prepare-model")?.description, COPY.skills.prepareModel);
		assert.equal(skills.find((skill) => skill.name === "prepare-engine")?.description, COPY.skills.prepareEngine);
		assert.equal(skills.some((skill) => skill.name === "user-fake"), false);
		assert.equal(skills.some((skill) => skill.name === "project-fake"), false);

		const prompt = buildSystemPrompt({
			cwd,
			customPrompt: loader.getSystemPrompt(),
			skills,
			selectedTools: ["read", "bash", "edit", "write"],
		});
		assert.ok(prompt.includes("<available_skills>"));
		assert.ok(prompt.includes("<name>prepare-model</name>"));
		assert.ok(prompt.includes(`<description>${COPY.skills.prepareModel}</description>`));
		assert.ok(prompt.includes("<name>prepare-engine</name>"));
		assert.ok(prompt.includes(`<description>${COPY.skills.prepareEngine}</description>`));
		assert.ok(!prompt.includes("user-fake"));
		assert.ok(!prompt.includes("project-fake"));
		assert.ok(!loader.getSystemPrompt()?.includes("<available_skills>"));
	});
});

test("skills-static-only: 产品路径不调用 packageManager.resolve", async () => {
	await withTempDirs(async ({ cwd, agentDir }) => {
		const resolveMock = mock.method(DefaultPackageManager.prototype, "resolve", async () => {
			throw new Error("packageManager.resolve must not run on the product staticOnly path");
		});
		try {
			const { loader } = await loadProductSkills(agentDir, cwd, [PRODUCT_SKILLS_DIR]);
			assert.equal(resolveMock.mock.callCount(), 0);
			assert.equal(loader.getSkills().skills.length, 3);
		} finally {
			resolveMock.mock.restore();
		}
	});
});

test("skills-static-only: 补全可见 /skill:prepare-model，回车注入 SKILL.md；enableSkillCommands 默认开", async () => {
	await withTempDirs(async ({ cwd, agentDir }) => {
		const { loader, settingsManager } = await loadProductSkills(agentDir, cwd, [PRODUCT_SKILLS_DIR]);
		assert.equal(settingsManager.getEnableSkillCommands(), true);
		const skills = loader.getSkills().skills;
		const completions = skills.map((skill) => `/skill:${skill.name}`);
		assert.ok(completions.includes("/skill:prepare-model"));
		assert.ok(completions.includes("/skill:prepare-engine"));

		const skill = skills.find((item) => item.name === "prepare-model");
		assert.ok(skill);
		const content = await readFile(skill.filePath, "utf8");
		const body = stripFrontmatter(content).trim();
		const expanded = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		assert.ok(expanded.includes("scripts/prepare-model.sh"));
		assert.ok(expanded.includes("准备本机模型权重"));
		assert.ok(!expanded.includes("https://"));
	});
});

test("skills-static-only: SKILL.md 只推荐脚本、不教任意 URL；脚本参数白名单", async () => {
	const modelSkill = await readFile(join(PRODUCT_SKILLS_DIR, "prepare-model", "SKILL.md"), "utf8");
	const engineSkill = await readFile(join(PRODUCT_SKILLS_DIR, "prepare-engine", "SKILL.md"), "utf8");
	const modelScript = await readFile(join(PRODUCT_SKILLS_DIR, "prepare-model", "scripts", "prepare-model.sh"), "utf8");
	const engineScript = await readFile(join(PRODUCT_SKILLS_DIR, "prepare-engine", "scripts", "prepare-engine.sh"), "utf8");
	for (const text of [modelSkill, engineSkill]) {
		assert.ok(!/https?:\/\//.test(text), "SKILL.md must not teach arbitrary URLs");
	}
	assert.ok(modelSkill.includes("scripts/prepare-model.sh"));
	assert.ok(engineSkill.includes("scripts/prepare-engine.sh"));
	assert.ok(modelSkill.includes("不要调用部署"));
	assert.ok(engineSkill.includes("不要调用部署"));
	assert.ok(modelScript.includes("hf download"));
	assert.ok(!/https?:\/\//.test(modelScript));
	assert.ok(engineScript.includes('vllm/vllm-openai:v0.8.5.post1'));
	assert.ok(engineScript.includes("lmsysorg/sglang:v0.4.6.post1"));
	assert.ok(engineScript.includes("docker pull"));
	assert.ok(!engineScript.includes("docker pull $"));
});

test("skills-static-only: 卸掉 Skill 目录后 loader 仍启动且技能为空", async () => {
	await withTempDirs(async ({ cwd, agentDir }) => {
		const missing = join(cwd, "missing-skills");
		const { loader } = await loadProductSkills(agentDir, cwd, [missing]);
		assert.deepEqual(loader.getSkills().skills, []);
		assert.ok(loader.getSkills().diagnostics.some((item) => item.message.includes("does not exist")));
	});
});
