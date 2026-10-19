"""Install only pinned public artifacts; runs at image build, never grading time."""
import hashlib,json,os,pathlib,platform,shutil,subprocess,tarfile,urllib.request
HERE=pathlib.Path(__file__).resolve().parent
MANIFEST=json.loads((HERE/'runtime-manifest.json').read_text())

def download(url,dest,digest):
    if dest.exists() and sha(dest)==digest:return
    tmp=dest.with_suffix(dest.suffix+'.part')
    with urllib.request.urlopen(url,timeout=120) as src,tmp.open('wb') as dst:shutil.copyfileobj(src,dst,1024*1024)
    if sha(tmp)!=digest:tmp.unlink();raise RuntimeError('Downloaded artifact hash mismatch')
    tmp.replace(dest)

def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(4*1024*1024),b''):h.update(block)
    return h.hexdigest()

def extract(archive,dest):
    dest.mkdir(parents=True,exist_ok=True);root=dest.resolve()
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            target=(root/member.name).resolve()
            if root not in target.parents and target!=root:raise ValueError('Unsafe archive path')
            if member.issym() or member.islnk():
                link=((target.parent if member.issym() else root)/member.linkname).resolve()
                if root not in link.parents and link!=root:raise ValueError('Unsafe archive link')
        tar.extractall(dest)

def runnable(server):
    env=dict(os.environ);env['LD_LIBRARY_PATH']=str(server.parent)+':'+env.get('LD_LIBRARY_PATH','')
    try:return subprocess.run([str(server),'--version'],env=env,capture_output=True,timeout=30).returncode==0
    except (OSError,subprocess.TimeoutExpired):return False

def main():
    rt=HERE/'runtime';rt.mkdir(exist_ok=True)
    arch={'x86_64':'x64','aarch64':'arm64','arm64':'arm64'}.get(platform.machine())
    if arch is None:raise RuntimeError('Unsupported CPU architecture')
    asset=MANIFEST['runtime']['assets'][arch];archive=rt/'prebuilt.tar.gz'
    download(asset['url'],archive,asset['sha256']);extract(archive,rt/'prebuilt')
    server=next((rt/'prebuilt').rglob('llama-server'))
    if not runnable(server):
        print('Prebuilt runtime does not load on this Linux image; compiling pinned source.',flush=True)
        source=MANIFEST['runtime']['source'];archive=rt/'source.tar.gz';download(source['url'],archive,source['sha256']);extract(archive,rt/'source')
        source_dir=next((rt/'source').glob('llama.cpp-*'));build=rt/'build'
        subprocess.run(['cmake','-S',str(source_dir),'-B',str(build),'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DGGML_NATIVE=OFF','-DGGML_CPU_ALL_VARIANTS=ON','-DGGML_OPENMP=ON','-DLLAMA_CURL=OFF','-DLLAMA_BUILD_TESTS=OFF'],check=True)
        subprocess.run(['cmake','--build',str(build),'--target','llama-server','-j','2'],check=True)
        server=build/'bin/llama-server'
        if not runnable(server):raise RuntimeError('Compiled runtime cannot execute')
    (rt/'server-path.txt').write_text(str(server.relative_to(rt))+'\n')
    model=MANIFEST['model'];model_dir=HERE/'models';model_dir.mkdir(exist_ok=True)
    download('https://huggingface.co/'+model['repo']+'/resolve/'+model['revision']+'/'+model['file'],model_dir/model['file'],model['sha256'])
    print('Pinned CPU runtime and Qwen3.5 weights installed and verified.',flush=True)

if __name__=='__main__':main()
