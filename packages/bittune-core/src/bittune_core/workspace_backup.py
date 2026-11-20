"""Owner-only snapshots, verified extraction, and restore to a new workspace.
No GPU commands, task replay, automatic retention, or in-place database restore.
"""
import argparse, contextlib, fcntl, hashlib, json, os, shutil, socket, sqlite3, sys, tarfile, tempfile, time, uuid
from pathlib import Path

def sha(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def read(path):return json.loads(Path(path).read_text())
def write(path,data):Path(path).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');Path(path).chmod(0o600)
def context():
 if os.environ.get('BITTUNE_BACKUP_CONTEXT'):return json.loads(os.environ['BITTUNE_BACKUP_CONTEXT'])
 home=Path(os.environ.get('BITTUNE_HOME',str(Path.home()/'.bittune')));agent=Path(os.environ.get('BITTUNE_AGENT_DIR',str(home/'agent')))
 return {'home':str(home),'core':os.environ.get('BITTUNE_CORE_HOME',str(home/'core')),'agent':str(agent),'sessions':os.environ.get('BITTUNE_SESSION_DIR',str(agent/'sessions'))}
def worker_idle(c):
 path=c.get('socket')
 if not path or not Path(path).exists():return
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(5)
 try:
  s.connect(path);s.sendall((json.dumps({'id':'backup-status','method':'engine_status','params':{}})+'\n').encode());data=json.loads(s.makefile('r').readline())
  if data.get('error') or data['result']['active'] or data['result'].get('inflight',0)>0:raise ValueError('Workspace has an active task/request; no backup was started')
 finally:s.close()
def copy(source,target):
 source=Path(source)
 if not source.exists():return
 if source.is_symlink():raise ValueError('Backup source must not be a symlink: '+source.name)
 if source.is_dir():shutil.copytree(source,target,ignore=shutil.ignore_patterns('node_modules','__pycache__','cache','staging','logs'),symlinks=True)
 else:target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)

@contextlib.contextmanager
def fence(c):
 with contextlib.ExitStack() as leases:
  if os.environ.get('BITTUNE_DELIVERY_LOCK'):
   lock=leases.enter_context(open(os.environ['BITTUNE_DELIVERY_LOCK'],'a+b'));fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  home=Path(c['home']);home.mkdir(parents=True,exist_ok=True,mode=0o700);flag=home/'maintenance.json'
  fd=os.open(flag,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
  with os.fdopen(fd,'w') as f:json.dump({'pid':os.getpid(),'reason':'backup'},f)
  try:
   worker_idle(c);core=Path(c['core']);core.mkdir(parents=True,exist_ok=True,mode=0o700)
   with (core/'core.lock').open('a+b') as f:
    fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);yield
  finally:flag.unlink(missing_ok=True)

def create(profile):
 c=context();repo=Path(profile['repository']).resolve()
 for key in ['home','core','agent','sessions']:
  if repo==Path(c[key]).resolve() or repo.is_relative_to(Path(c[key]).resolve()):raise ValueError('Backup repository must be outside workspace data')
 repo.mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(repo,0o700)
 private_files=profile.get('private_files',[])+[path for path in profile.get('optional_private_files',[]) if Path(path).exists()]
 snapshot='backup-'+time.strftime('%Y%m%d%H%M%S',time.gmtime())+'-'+uuid.uuid4().hex[:8]
 with (repo/'.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  with tempfile.TemporaryDirectory(dir=repo,prefix='.snapshot-') as tmp, fence(c):
   stage=Path(tmp);(stage/'core').mkdir();core=Path(c['core']);db=core/'bittune.db'
   if db.exists():
    source=sqlite3.connect(db.resolve().as_uri()+'?mode=ro',uri=True);dest=sqlite3.connect(stage/'core/bittune.db');source.backup(dest);dest.close();source.close()
   for name in ['artifacts','profiles','report-signing']:copy(core/name,stage/'core'/name)
   copy(c['agent'],stage/'agent');copy(c['sessions'],stage/'sessions');copy(Path(c['home'])/'workbench',stage/'workbench');copy(Path(c['home'])/'state',stage/'state')
   for index,path in enumerate(private_files):
    if not Path(path).is_file():raise ValueError('Private backup input must be an existing file')
    copy(path,stage/'private'/str(index))
   for f in stage.rglob('*'):
    if f.is_symlink():raise ValueError('Snapshot contains a symlink; target was not followed')
   files={str(f.relative_to(stage)):sha(f) for f in sorted(stage.rglob('*')) if f.is_file()}
   manifest={'format':'bittune-backup-v1','snapshot_id':snapshot,'created_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'context':c,'private_files':private_files,'files':files};write(stage/'backup-manifest.json',manifest)
   archive=repo/(snapshot+'.tar.gz')
   with tarfile.open(archive,'w:gz') as tar:tar.add(stage,arcname='snapshot')
   archive.chmod(0o600);info={'snapshot_id':snapshot,'created_at':manifest['created_at'],'files':len(files),'sha256':sha(archive)};write(repo/(snapshot+'.json'),info);return info

def verify(profile,snapshot,target=None):
 if not __import__('re').fullmatch('backup-[0-9]{14}-[a-f0-9]{8}',snapshot):raise ValueError('Invalid snapshot ID')
 repo=Path(profile['repository']);info=read(repo/(snapshot+'.json'));archive=repo/(snapshot+'.tar.gz')
 if sha(archive)!=info['sha256']:raise ValueError('Backup archive checksum mismatch')
 if target:
  destination=Path(target).resolve()
  if destination.exists():raise ValueError('Restore target must be a new directory')
  destination.mkdir(parents=True,mode=0o700)
 else:destination=Path(tempfile.mkdtemp(prefix='bittune-verify-'))
 try:
  with tarfile.open(archive) as tar:tar.extractall(destination,filter='data')
  root=destination/'snapshot';m=read(root/'backup-manifest.json')
  if m.get('format')!='bittune-backup-v1':raise ValueError('Unsupported backup format')
  for name,digest in m['files'].items():
   f=root/name
   if f.is_symlink() or not f.resolve().is_relative_to(root.resolve()) or sha(f)!=digest:raise ValueError('Snapshot content verification failed')
  if (root/'core/bittune.db').exists():
   db=sqlite3.connect((root/'core/bittune.db').resolve().as_uri()+'?mode=ro',uri=True);assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok';db.close()
  return {**info,'verified':True,'restored_to':str(root) if target else None,'active_workspace_changed':False}
 finally:
  if not target:shutil.rmtree(destination)

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('operation',choices=['create','list','verify','restore']);parser.add_argument('--profile',required=True);parser.add_argument('--snapshot');parser.add_argument('--target');a=parser.parse_args();p=read(a.profile)
 if a.operation=='create':result=create(p)
 elif a.operation=='list':result={'snapshots':[read(f) for f in sorted(Path(p['repository']).glob('backup-*.json'),reverse=True)]}
 elif a.operation in ['verify','restore']:
  if not a.snapshot:raise ValueError('--snapshot is required')
  if a.operation=='restore' and not a.target:raise ValueError('--target is required')
  result=verify(p,a.snapshot,a.target if a.operation=='restore' else None)
 print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':
 try:main()
 except Exception as error:print(json.dumps({'error':type(error).__name__,'message':str(error).splitlines()[0]},ensure_ascii=False),file=sys.stderr);sys.exit(1)
