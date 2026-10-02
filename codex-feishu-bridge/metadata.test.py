"""Synthetic database tests only; fixtures live in the OS temporary directory."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
SOURCE = Path(__file__).with_name('list-user-threads.py')
spec = importlib.util.spec_from_file_location('metadata', SOURCE)
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)
class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='cfb-metadata-')
        self.path = Path(self.tmp.name) / 'Other User 中文' / 'state_5.sqlite'
        self.path.parent.mkdir()
        self.db = sqlite3.connect(self.path)
        self.db.executescript('''
            CREATE TABLE threads (id TEXT,cwd TEXT,project_id TEXT,updated_at INT,updated_at_ms INT,
                                  archived INT,thread_source TEXT,source TEXT);
            CREATE TABLE thread_spawn_edges (child_thread_id TEXT);
        ''')
        self.db.commit()
    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()
    def add(self,identity,archived=0,thread_source='user',source='user'):
        self.db.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)',
                        (identity,'D:/fixture/project','project',1,1000,archived,thread_source,source))
        self.db.commit()
    def test_filters_archives_agents_and_spawned_children(self):
        self.add('visible');self.add('archived',archived=1);self.add('agent',thread_source='subagent')
        self.add('guardian',source='guardian_review');self.add('nested',source='{"subagent":{}}')
        self.add('edge-child');self.db.execute('INSERT INTO thread_spawn_edges VALUES (?)',('edge-child',));self.db.commit()
        output=metadata.list_user_threads(self.path)
        self.assertEqual([t['id'] for t in output['threads']],['visible'])
        self.assertEqual(set(output['threads'][0]),{'id','cwd','project_id','updated_at','updated_at_ms'})
    def test_validation_reads_no_task_content_and_does_not_change_bytes(self):
        self.add('fixture');before=self.path.read_bytes()
        self.assertEqual(metadata.list_user_threads(self.path,True),{'compatible':True,'readOnly':True})
        self.assertEqual(self.path.read_bytes(),before)
    def test_missing_database_is_not_created(self):
        target=self.path.parent/'missing.sqlite'
        with self.assertRaises(ValueError):metadata.list_user_threads(target)
        self.assertFalse(target.exists())
    def test_missing_schema_column_is_rejected(self):
        self.db.execute('ALTER TABLE threads RENAME COLUMN project_id TO incompatible');self.db.commit()
        with self.assertRaisesRegex(ValueError,'unsupported_codex_schema:threads'):metadata.list_user_threads(self.path)
    def test_missing_spawn_table_is_rejected(self):
        self.db.execute('DROP TABLE thread_spawn_edges');self.db.commit()
        with self.assertRaisesRegex(ValueError,'thread_spawn_edges'):metadata.list_user_threads(self.path)
    def test_explicit_cli_database_wins_over_wrong_environment(self):
        env=dict(os.environ,CODEX_FEISHU_DATABASE=str(self.path.parent/'wrong.sqlite'))
        result=subprocess.run([sys.executable,'-I',str(SOURCE),'--database',str(self.path),'--validate'],env=env,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(json.loads(result.stdout)['compatible'])
        self.assertFalse((self.path.parent/'wrong.sqlite').exists())
    def test_no_implicit_current_user_database_fallback(self):
        env=dict(os.environ);env.pop('CODEX_FEISHU_DATABASE',None)
        result=subprocess.run([sys.executable,'-I',str(SOURCE),'--validate'],env=env,capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,'')
if __name__=='__main__': unittest.main()
