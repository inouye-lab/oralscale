#!/usr/bin/env python3
"""INV-DEBUG-1: synthetic certificates only; no accounts, models or real records."""
import copy,json,os,pathlib,subprocess,sys,tempfile,time,unittest,wave
ROOT=pathlib.Path(__file__).resolve().parents[1];SRC=ROOT/'autograder/source'
sys.path.insert(0,str(SRC));import protocol
class DebugIdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='oralscale-debug-test-');self.p=pathlib.Path(self.tmp.name)
        self.sub=self.p/'submission';self.sub.mkdir();self.secret='synthetic-debug-test-secret'
        self.email='synthetic.student@example.invalid';self.teacher='synthetic.teacher@example.invalid'
        self.bank={'bankId':'synthetic','questions':[{'id':'water','prompt':'Why does ice melt when heated?',
            'keyPoints':['heat supplies energy for melting'],'referenceAnswer':'Heat supplies energy for melting.'}]}
        (self.p/'bank.json').write_text(json.dumps(self.bank))
        self.course={'courseId':'synthetic-debug','pseudonymSalt':'synthetic','defaults':{'limitSec':120,'questionsPerAttempt':1,'requireAccessKey':True,'gradingBackend':'heuristic','allowPrivateCode':False},'assignments':{'quiz-03':{'bank':str(self.p/'bank.json'),'shortTitle':'Oral Quiz 3'}}}
        with wave.open(str(self.sub/'answer.wav'),'wb') as f:
            f.setnchannels(1);f.setsampwidth(2);f.setframerate(8000);f.writeframes(b'\0\0'*8000*70)
        now=int(time.time());self.cert=dict(v=2,kind='certificate',courseId=self.course['courseId'],assignmentId='quiz-03',attemptId='synthetic-debug',studentRef=protocol.student_ref_for_email(self.secret,self.course['courseId'],self.email,1),accessKeyVerified=True,audioSHA256=protocol.sha256_hex_file(str(self.sub/'answer.wav')),tReveal=now-70,tFinish=now,deadline=now+100,elapsedSec=70,limitSec=120,bufferSec=20,questionOffsetSec=10,closingOffsetSec=60,codeLeadSec=10,tailLimitSec=16,codeDigits=6,questionsPerAttempt=1,segments=[dict(index=0,questionId='water',questionOffsetSec=10,closingOffsetSec=60,limitSec=120,bufferSec=20)])
        digits=['zero','one','two','three','four','five','six','seven','eight','nine'];self.words=[]
        for k in range(2):
            for i,d in enumerate(protocol.derive_boundary_code(self.secret,'synthetic-debug',k,1,6)):
                self.words.append(dict(word=digits[int(d)],start=60*k+.2+i*.1,end=60*k+.25+i*.1))
        for i,w in enumerate('umm like heat supplies energy for melting the ice so the solid turns into liquid water'.split()):
            self.words.append(dict(word=w,start=11+i*.2,end=11.1+i*.2))
        self.words.sort(key=lambda w:w['start'])
    def tearDown(self):self.tmp.cleanup()
    def run_case(self,debug=True,who=None,change=None,damage=None):
        c=copy.deepcopy(self.course);cert=copy.deepcopy(self.cert);words=copy.deepcopy(self.words)
        if debug:c['debugAutograder']={'identityCheck':'flag-only','assignmentId':'quiz-03','label':'DEBUG'}
        if change:change(cert)
        token=protocol.sign_token('wrong-secret' if damage=='signature' else self.secret,cert)
        (self.p/'course.json').write_text(json.dumps(c));(self.sub/'certificate.json').write_text(json.dumps({**cert,'certificateToken':token,'audioFile':'answer.wav'}))
        if damage=='codes':words=[w for w in words if 10<w['start']<60]
        (self.sub/'words.json').write_text(json.dumps(words))
        (self.p/'metadata.json').write_text(json.dumps({'users':[] if who=='' else [{'email':who or self.teacher}]}))
        env=dict(os.environ,ORALSCALE_SECRET=self.secret,ORALSCALE_COURSE=str(self.p/'course.json'),ORALSCALE_ASSIGNMENT='quiz-03',ORALSCALE_SUBMISSION=str(self.sub),ORALSCALE_METADATA=str(self.p/'metadata.json'),ORALSCALE_RESULTS=str(self.p/'results.json'),ORALSCALE_ALLOW_TRANSCRIPT_SIDECAR='1',ORALSCALE_STUDENT='',PYTHONPATH=str(SRC))
        env.pop('ORALSCALE_GRADING_BACKEND',None)
        # Synthetic timestamp sidecars stand in for ASR; don't load a speech model for missing-code tests.
        code='import transcribe; transcribe.rescue_window=lambda *a,**k: ("",[]); import run_autograder; run_autograder.main()'
        r=subprocess.run([sys.executable,'-c',code],env=env,capture_output=True,text=True,timeout=30)
        self.assertEqual(r.returncode,0,r.stderr)
        result=json.loads((self.p/'results.json').read_text())
        detail=result['tests'][-1];summary=result['tests'][-2]
        self.assertEqual(detail['name'],'Timing breakdown (instructor only)')
        self.assertEqual(detail['visibility'],'hidden')
        self.assertEqual(summary['name'],'Grading time');self.assertEqual(summary['visibility'],'visible')
        for label in ['Grading started:','Grading finished:','Total grading time:','America/Indiana/Indianapolis']:
            self.assertIn(label,summary['output'])
        self.assertNotIn('Main stages',summary['output'])
        self.assertIn('MEMORY DIAGNOSTICS',detail['output'])
        self.assertNotIn('MEMORY DIAGNOSTICS',summary['output'])
        if any(t['name']=='Feedback on your explanation' for t in result['tests']):
            self.assertEqual(result['tests'][0]['name'],'Feedback on your explanation')
            self.assertIn('Audio transcription',detail['output'])
            self.assertIn('Answer grading',detail['output'])
        return result
    def assert_blocked(self,r):
        self.assertEqual(r['score'],0);self.assertFalse(any(t['name'].startswith('Question ') for t in r['tests']))
    def test_normal_rejects_identity_mismatch(self):self.assert_blocked(self.run_case(False))
    def test_debug_mismatch_grades_and_flags(self):
        r=self.run_case();self.assertGreater(r['score'],0);self.assertIn('DEBUG AUTOGRADER',r['output'])
        t=next(t for t in r['tests'] if 'Identity (DEBUG' in t['name']);self.assertEqual(t['status'],'failed');self.assertEqual(t['visibility'],'visible')
        self.assertTrue(any('REVIEW' in t['name'] for t in r['tests']))
    def test_debug_matching_remains_labeled_and_same_score(self):
        normal=self.run_case(False,self.email);debug=self.run_case(True,self.email)
        self.assertGreater(normal['score'],0);self.assertEqual(debug['score'],normal['score']);self.assertIn('DEBUG',debug['output'])
    def test_missing_identity_flagged_in_debug(self):
        r=self.run_case(who='');self.assertGreater(r['score'],0)
        self.assertTrue(any('MISMATCH' in t['name'] and t['status']=='failed' for t in r['tests']))
    def test_signature_enforced(self):self.assert_blocked(self.run_case(damage='signature'))
    def test_audio_hash_enforced(self):self.assert_blocked(self.run_case(change=lambda c:c.update(audioSHA256='0'*64)))
    def test_assignment_enforced(self):self.assert_blocked(self.run_case(change=lambda c:c.update(assignmentId='quiz-99')))
    def test_course_enforced(self):self.assert_blocked(self.run_case(change=lambda c:c.update(courseId='another-course')))
    def test_access_key_enforced(self):self.assert_blocked(self.run_case(change=lambda c:c.update(accessKeyVerified=False)))
    def test_spoken_codes_enforced(self):self.assert_blocked(self.run_case(damage='codes'))
    def test_timing_enforced(self):self.assert_blocked(self.run_case(change=lambda c:c.update(elapsedSec=10)))
if __name__=='__main__':unittest.main()
