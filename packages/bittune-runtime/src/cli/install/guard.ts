import {basename,dirname,join,resolve,sep} from "node:path";
import {existsSync} from "node:fs";
import {realpath} from "node:fs/promises";
import lockfile from "proper-lockfile";
import {getPackageDir} from "../../config.ts";

/** Installed clients wait for the existing install lock, without starting any work. */
export async function assertInstallationAvailable(root?:string){
  const packageRoot=getPackageDir();
  root ||= process.env.BITTUNE_INSTALL_ROOT || (basename(packageRoot)==="agent"?dirname(packageRoot):undefined);
  if(root&&existsSync(root)&&await lockfile.check(root,{lockfilePath:join(root,".install.lock")}))throw new Error("Bittune正在安装或回退软件，请完成后重新连接；原任务记录保留。");
}

/** Account/workspace data cannot be included in the directories being replaced. */
export async function assertDataOutsideSoftware(root:string,dataPaths:string[]){
  async function canonical(path:string):Promise<string>{
    path=resolve(path);
    try{return await realpath(path);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return join(await canonical(dirname(path)),basename(path));}
  }
  const software=await Promise.all(["agent","py","node"].map(name=>canonical(join(root,name))));
  for(const path of dataPaths){const data=await canonical(path);if(software.some(base=>data===base||data.startsWith(base+sep)))throw new Error("工作区或账号数据与软件目录重叠，尚未变更软件；请先将数据与agent/py/node目录分开。");}
}
