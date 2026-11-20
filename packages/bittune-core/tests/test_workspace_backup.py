"""Temporary CPU-only workspace data; never model measurement or production account data."""
import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from bittune_core.store import CoreStore
from bittune_core.workspace_backup import create,verify

class WorkspaceBackupTests(unittest.TestCase):
 def test_round_trip_preserves_native_database_artifacts_and_private_files(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);home=p/'workspace';core=home/'core';store=CoreStore(core);run,_=store.start_run('backup-fixture','managed',{'fixture_only':True},'fixture');artifact=store.write_artifact(run,'fixture','development fixture','text/plain');store.finish_run(run,'completed',{});store.close()
   agent=home/'agent';(agent/'sessions').mkdir(parents=True);(agent/'sessions/one.jsonl').write_text('{"fixture_only":true}\n');secret=p/'private.env';secret.write_text('DEVELOPMENT_FIXTURE=not-a-real-credential\n')
   c={'home':str(home),'core':str(core),'agent':str(agent),'sessions':str(agent/'sessions')};profile={'repository':str(p/'snapshots'),'private_files':[str(secret)]}
   with patch.dict(os.environ,{'BITTUNE_BACKUP_CONTEXT':json.dumps(c)}):snapshot=create(profile)
   result=verify(profile,snapshot['snapshot_id'],p/'restored');self.assertTrue(result['verified']);root=p/'restored/snapshot'
   restored=CoreStore(root/'core',read_only=True)
   try:self.assertEqual(restored.read_artifact_text(artifact['artifact_id'])['text'],'development fixture');self.assertEqual(len(restored.list_runs(limit=10)),1)
   finally:restored.close()
   self.assertEqual((root/'private/0').read_bytes(),secret.read_bytes());self.assertEqual((Path(profile['repository'])/(snapshot['snapshot_id']+'.tar.gz')).stat().st_mode&0o777,0o600)
   with self.assertRaises(ValueError):verify(profile,snapshot['snapshot_id'],p/'restored')
   self.assertFalse((home/'maintenance.json').exists())
 def test_corruption_and_active_maintenance_do_not_overwrite_data(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);home=p/'home';core=home/'core';store=CoreStore(core);store.close();agent=home/'agent';agent.mkdir();c={'home':str(home),'core':str(core),'agent':str(agent),'sessions':str(agent/'sessions')};profile={'repository':str(p/'repo')}
   with patch.dict(os.environ,{'BITTUNE_BACKUP_CONTEXT':json.dumps(c)}):s=create(profile)
   file=p/'repo'/(s['snapshot_id']+'.tar.gz');file.write_bytes(file.read_bytes()+b'corruption')
   with self.assertRaises(ValueError):verify(profile,s['snapshot_id'],p/'no-restore')
   self.assertFalse((p/'no-restore').exists())
   (home/'maintenance.json').write_text('{"pid":1}')
   with patch.dict(os.environ,{'BITTUNE_BACKUP_CONTEXT':json.dumps(c)}):
    with self.assertRaises(FileExistsError):create(profile)
   self.assertTrue((home/'maintenance.json').exists())
