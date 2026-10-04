# Region labels per vertex for the ninja mesh (scaled, Blender Z-up, facing -Y)
import sys; sys.path.append("/home/shikhar/Projects/samurai/.venv/lib/python3.14/site-packages")
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
LAB=dict(torso=0,armL=1,armR=2,legL=3,legR=4,coat=5,scarf=6,sword=7,head=8,pelvis=9,rigid=10)
def seg_dist(P,a,b):
    a=np.asarray(a,float); b=np.asarray(b,float)
    ab=b-a; t=np.clip(((P-a)@ab)/max(ab@ab,1e-12),0,1); Q=a+t[:,None]*ab; return np.linalg.norm(P-Q,axis=1),t
def graph(co,tris):
    nv=len(co); e=np.concatenate([tris[:,[0,1]],tris[:,[1,2]],tris[:,[2,0]]])
    A=coo_matrix((np.ones(len(e)),(e[:,0],e[:,1])),shape=(nv,nv)).tocsr(); A=((A+A.T)>0).astype(np.float64)
    w=np.linalg.norm(co[e[:,0]]-co[e[:,1]],axis=1)+1e-6
    G=coo_matrix((w,(e[:,0],e[:,1])),shape=(nv,nv)).tocsr(); G=G.maximum(G.T)
    return A,G
def smooth(A,f,it):
    d=np.asarray(A.sum(1)).ravel()+1e-9
    for _ in range(it): f=0.5*f+0.5*(A@f)/d
    return f
def sword_mask(co,sword_segs,r=0.03):
    m=np.zeros(len(co),bool)
    for a,b in sword_segs: m|=seg_dist(co,a,b)[0]<r
    return m
def compute(co,tris,sdf,J,sword_segs):
    nv=len(co); A,G=graph(co,tris); z=co[:,2]; x=co[:,0]; y=co[:,1]
    j=lambda n: np.array(J[n])
    thin=smooth(A,(sdf<0.04).astype(float),2)>0.5
    lab=np.full(nv,LAB["torso"],np.int8)
    belt=j("Hips")[2]-0.02
    crotch=j("Hips")[2]-0.21   # where the two leg tubes split (x-sections)
    neckz=j("Neck")[2]
    lab[z>neckz+0.03]=LAB["head"]
    arm={}
    for S,key in (("Left","armL"),("Right","armR")):
        sh,el,wr=j(S+"Arm"),j(S+"ForeArm"),j(S+"Hand")
        ht=wr+(wr-el)/np.linalg.norm(wr-el)*0.13
        d1,_=seg_dist(co,sh,el); d2,_=seg_dist(co,el,wr); d3,_=seg_dist(co,wr,ht)
        ax=(el-sh)/np.linalg.norm(el-sh)
        x0=J["Hips"][0]
        beyond=(((co-sh)@ax)>-0.01)&(np.abs(co[:,0]-x0)>abs(sh[0]-x0)-0.015)
        fing=np.full(nv,9.0)
        for k in J:
            if k.startswith(S+"Hand") and k!=S+"Hand" and not k.endswith("4") and k[:-1]+str(int(k[-1])+1) in J:
                fing=np.minimum(fing,seg_dist(co,J[k],J[k[:-1]+str(int(k[-1])+1)])[0])
        arm[key]=((beyond&(d1<0.11))|(d2<0.085)|(d3<0.075)|(fing<0.035))&(z<neckz+0.03)
    sw=sword_mask(co,sword_segs)
    # scarf: thin sheet behind right shoulder blade (largest component)
    scarf=thin&(y>0.04)&(x<0.0)&(z>0.55)&(z<neckz+0.02)&~sw
    idx=np.where(scarf)[0]; n,lb=connected_components(A[scarf][:,scarf],directed=False)
    big=np.argmax(np.bincount(lb)); scarf=np.zeros(nv,bool); scarf[idx[lb==big]]=True
    for _ in range(2): scarf|=(A@scarf.astype(float)>0)&thin&(y>0.02)&(z>0.55)&~sw
    for k,m in arm.items(): lab[m&~scarf]=LAB[k]
    # ---- below the belt: geodesic competition between cores ----
    low=(z<belt+0.02)&~arm["armL"]&~arm["armR"]&~sw&~scarf
    cores={}
    for S,key in (("Left","legL"),("Right","legR")):
        segs=[(j(S+"UpLeg"),j(S+"Leg")),(j(S+"Leg"),j(S+"Foot")),(j(S+"Foot"),j(S+"ToeBase")),(j(S+"ToeBase"),j(S+"Toe_End"))]
        d=np.min([seg_dist(co,a,b)[0] for a,b in segs],axis=0)
        cores[key]=low&~thin&(d<0.15)&(z<crotch-0.02)
    cores["coat"]=low&thin&(z>0.3)
    cores["pelvis"]=low&~thin&(z>crotch+0.02)
    keys=list(cores); D=[]
    # graph restricted so geodesics can't shortcut through the sword / arms
    for k in keys:
        src=np.where(cores[k])[0]
        D.append(dijkstra(G,indices=src,min_only=True) if len(src) else np.full(nv,np.inf))
    D=np.array(D); win=np.argmin(D,0)
    for i,k in enumerate(keys):
        m=low&(win==i)
        lab[m]=LAB[k]
    lab[sw]=LAB["sword"]; lab[scarf]=LAB["scarf"]
    return lab,A,thin
