#!/usr/bin/env python3
"""INV-USE-6: deterministic clocks, no model or private input needed."""
import pathlib,sys,unittest,tempfile
from unittest.mock import patch
from datetime import datetime, timezone
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'autograder/source'))
import runtiming as T

class TimingTests(unittest.TestCase):
    def test_console_lifecycle_is_flushed_and_exception_text_private(self):
        t=T.Timeline(lambda:1000,lambda:10)
        t.console=True
        with patch('builtins.print') as output:
            t.stage('Audio transcription')
            with self.assertRaises(ValueError):
                with t.span('Qwen inference'):
                    raise ValueError('PRIVATE TRANSCRIPT MUST NOT APPEAR')
            t.heartbeat()
        lines='\n'.join(t.diagnostics)
        self.assertIn('SPAN_INTERRUPTED/FAILED',lines)
        self.assertIn('HEARTBEAT',lines)
        self.assertNotIn('PRIVATE TRANSCRIPT',lines)
        self.assertTrue(all(c.kwargs.get('flush') for c in output.call_args_list))
        self.assertTrue(all(t.run_id in line for line in t.diagnostics))
        self.assertIn('Lifecycle diagnostics',t.finish()[1])

    def test_lifecycle_output_is_instructor_only(self):
        source=(pathlib.Path(__file__).resolve().parents[1]/'autograder/source/run_autograder.py').read_text()
        self.assertIn('"stdout_visibility": "hidden"',source)
        self.assertIn('add("Timing breakdown (instructor only)", True, breakdown)',source)
        self.assertLess(source.index('json.dump({"score"'),source.index('timing.emit("RESULTS_WRITE_COMPLETED'))

    def test_launcher_reports_real_exit_status(self):
        import subprocess
        launcher=pathlib.Path(__file__).resolve().parents[1]/'autograder/run_autograder'
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)
            (p/'run_autograder').write_bytes(launcher.read_bytes())
            for code in (0,7):
                (p/'run_autograder.py').write_text('raise SystemExit('+str(code)+')')
                r=subprocess.run(['bash',str(p/'run_autograder')],capture_output=True,text=True)
                self.assertEqual(r.returncode,code)
                self.assertIn('EXIT status='+str(code),r.stdout)

    def test_purdue_dst(self):
        winter=datetime(2026,1,15,17,4,5,tzinfo=timezone.utc).timestamp()
        summer=datetime(2026,7,15,16,4,5,tzinfo=timezone.utc).timestamp()
        self.assertIn('12:04:05 PM EST (UTC-0500)',T.timestamp(winter))
        self.assertIn('12:04:05 PM EDT (UTC-0400)',T.timestamp(summer))
        self.assertIn('January 15, 2026',T.timestamp(winter))
    def test_monotonic_accounting_and_early_finish(self):
        wall=[1000.];mono=[10.]
        t=T.Timeline(lambda:wall[0],lambda:mono[0])
        wall[0]+=4;mono[0]+=4;t.stage('transcription')
        wall[0]-=20;mono[0]+=6
        summary,detail=t.finish()
        self.assertEqual([r['seconds'] for r in t.stages],[4,6])
        self.assertIn('(10.000 seconds)',summary)
        self.assertEqual(t.finish(),(summary,detail))
        early=T.Timeline(lambda:1000,lambda:1);early.finish()
        self.assertEqual(len(early.stages),1)
    def test_failed_nested_span(self):
        t=T.Timeline()
        with self.assertRaises(ValueError):
            with t.span('Inference'):raise ValueError('PRIVATE: never record this')
        summary,detail=t.finish()
        self.assertIn('interrupted/failed',detail)
        self.assertIn('do not add again',detail)
        self.assertNotIn('PRIVATE',detail)
        self.assertNotIn('Inference',summary)
    def test_feedback_order_is_stable(self):
        names=['Validation checks','Grading detail (instructor only)','Question 1 of 2 — Test','Overall Score (drop lowest)','Question 2 of 2 — Test (DROPPED, does not count)','DEBUG']
        out=T.feedback_first([{'name':n} for n in names])
        self.assertEqual([x['name'] for x in out],[names[i] for i in [2,4,3,0,1,5]])
        self.assertEqual(T.feedback_first([{'name':'Validation'}, {'name':'Feedback on your explanation'}])[0]['name'],'Feedback on your explanation')
class MemoryTests(unittest.TestCase):
    def test_cgroup_samples_peak_limit_and_bars(self):
        import resourcestats as M
        for kind in ['v1','v2']:
            with tempfile.TemporaryDirectory() as d:
                paths=tuple(pathlib.Path(d)/n for n in ['current','peak','limit'])
                for p,v in zip(paths,[2*M.GIB,3*M.GIB,6*M.GIB]):p.write_text(str(v))
                m=M.MemoryMonitor(probe=lambda:(kind,paths),wall=lambda:1000)
                m.sample();paths[0].write_text(str(M.GIB))
                result=m.finish(T.timestamp)
                self.assertIn('Peak among periodic/stage-boundary samples: 2.000 GiB',result)
                self.assertIn('Kernel-recorded cgroup peak: 3.000 GiB',result)
                self.assertIn('Cgroup memory limit: 6.000 GiB',result)
                self.assertIn('########',result)
                self.assertIn('50.0% of cap; 3.000 GiB headroom',result)
                self.assertEqual(len(m.samples),2)
    def test_ten_second_sampler_and_unavailable_fallback(self):
        import resourcestats as M
        m=M.MemoryMonitor(probe=lambda:(None,()))
        with patch.object(m.stop_event,'wait',side_effect=[False,True]) as wait,patch.object(m,'sample') as sample:
            m._loop();self.assertEqual(sample.call_count,1)
            self.assertEqual([c.args[0] for c in wait.call_args_list],[10,10])
        report=m.finish(T.timestamp)
        self.assertIn('Container memory unavailable',report)
        self.assertIn('Python process peak RSS',report)
    def fixture(self, kind, group='/parent/leaf', root='/', hierarchy=True):
        import resourcestats as M
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        p=pathlib.Path(temp.name);proc=p/'proc';(proc/'self').mkdir(parents=True)
        mount=p/'cg';mount.mkdir()
        line='0::'+group if kind=='v2' else '5:cpu,memory:'+group
        (proc/'self/cgroup').write_text(line+'\n')
        fs='cgroup2 cgroup rw' if kind=='v2' else 'cgroup cgroup rw,memory'
        (proc/'self/mountinfo').write_text(f'1 0 0:1 {root} {mount} rw - {fs}\n')
        relative=group[len(root):].lstrip('/') if group.startswith(root) else ''
        leaf=mount/relative;leaf.mkdir(parents=True,exist_ok=True)
        for directory in [leaf,leaf.parent,mount]:
            for n,v in zip(M.FILES[kind],['100','200','max' if kind=='v2' else str(2**63-1)]):
                (directory/n).write_text(v)
            (directory/'memory.use_hierarchy').write_text('1' if hierarchy else '0')
        return proc,mount,leaf

    def test_ancestor_limit_and_mount_root_mapping(self):
        import resourcestats as M
        for kind in ['v1','v2']:
            proc,mount,leaf=self.fixture(kind)
            (leaf.parent/M.FILES[kind][2]).write_text(str(6*M.GIB))
            k,groups,chosen=M.discover_cgroup(proc)
            self.assertEqual(k,kind);self.assertEqual(groups[chosen]['root'],leaf.parent)
            self.assertEqual(groups[chosen]['group'],'/parent')
            self.assertTrue(M.inside('/parent/leaf','/parent'))
            self.assertFalse(M.inside('/parent-other','/parent'))
        proc,mount,leaf=self.fixture('v1',group='/host/container',root='/host/container')
        (leaf/M.FILES['v1'][2]).write_text(str(6*M.GIB))
        _,groups,chosen=M.discover_cgroup(proc)
        self.assertEqual(groups[chosen]['root'],mount)
        proc,mount,leaf=self.fixture('v2',group='/',root='/host/container')
        self.assertEqual(M.discover_cgroup(proc)[1][0]['root'],mount)

    def test_v1_nonhierarchical_ancestor_not_a_cap(self):
        import resourcestats as M
        proc,mount,leaf=self.fixture('v1',hierarchy=False)
        (leaf.parent/M.FILES['v1'][2]).write_text(str(6*M.GIB))
        _,groups,chosen=M.discover_cgroup(proc)
        self.assertEqual(len(groups),1);self.assertIsNone(groups[chosen]['limit'])

    def test_system_view_and_live_model_scope(self):
        import resourcestats as M
        proc,mount,leaf=self.fixture('v2')
        (leaf/M.FILES['v2'][2]).write_text(str(6*M.GIB))
        (proc/'meminfo').write_text('MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n')
        self.assertEqual(M.system_memory(proc/'meminfo')['used_or_unavailable'],8*M.GIB)
        pid=proc/'42';pid.mkdir()
        (pid/'status').write_text('VmRSS: 3145728 kB\nVmHWM: 4194304 kB\nRssFile: 2097152 kB\n')
        (pid/'smaps_rollup').write_text('Pss: 2621440 kB\n')
        self.assertEqual(M.process_memory(42,proc)['Pss'],2.5*M.GIB)
        with patch.object(M,'discover_cgroup',return_value=M.discover_cgroup(proc)):
            m=M.MemoryMonitor()
        # Scope is checked against the model's actual cgroup membership, not RSS.
        original=pathlib.Path.read_text
        def read(path,*a,**kw):
            if str(path)=='/proc/42/cgroup':return '0::/parent/leaf\n'
            return original(path,*a,**kw)
        with patch.object(pathlib.Path,'read_text',read),patch.object(M,'process_memory',return_value={'VmRSS':3*M.GIB}):
            m.record_model(42);report=m.finish(T.timestamp)
        self.assertTrue(m.model_in_scope);self.assertIn('verified inside',report)
        self.assertIn('VmRSS=3.000 GiB',report)
        self.assertIn('not added to cgroup totals',report)
        def outside_read(path,*a,**kw):
            if str(path)=='/proc/42/cgroup':return '0::/unrelated\n'
            return original(path,*a,**kw)
        with patch.object(pathlib.Path,'read_text',outside_read):
            self.assertIn('OUTSIDE the measured group',m.finish(T.timestamp))

    def test_diagnostic_failure_does_not_break_finish(self):
        t=T.Timeline()
        with patch('resourcestats.find_cgroup',side_effect=OSError):
            # Constructor injection exercises an inaccessible cgroup read.
            import resourcestats as M
            m=M.MemoryMonitor(probe=lambda:('v2',(pathlib.Path('/nonexistent'),)*3))
            m.sample();self.assertEqual(m.samples,[])
        t.memory=m
        with patch.object(m,'finish',side_effect=OSError):
            summary,detail=t.finish()
        self.assertIn('Total grading time',summary)
        self.assertIn('Memory diagnostics unavailable',detail)

if __name__=='__main__':unittest.main()
