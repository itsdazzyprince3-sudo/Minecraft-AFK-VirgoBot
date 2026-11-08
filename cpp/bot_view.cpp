// bot_view.cpp - First-person software raycaster and perception feed for the bot.
// Protocol v2: tag(4) + u32le length + payload over TCP; world snapshots are
// incremental (VWLD once, VBLK deltas after), pose/entities arrive every tick
// (VFRM), and the renderer sends back a compact PERC summary of what it sees.
// HTTP: /            dashboard with live MJPEG
//       /stream      multipart MJPEG
//       /frame       single JPEG
//       /frame.bmp   24-bit BMP (used by the Node vision controller)
//       /state       text stats
// Language: C++17, target: Linux/Android ARM64, g++.
// Build: g++ -O2 -std=c++17 -pthread cpp/bot_view.cpp -o cpp/bot_view
// Run:   ./cpp/bot_view [--frame-host 127.0.0.1] [--frame-port 31337]
//                       [--http-port 8080] [--w 320] [--h 180] [--threads N]
//                       [--fps 120] [--stream-fps 30] [--quality 70]
//                       [--mock] [--bench 5] [--selftest]
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <cstdint>
#include <vector>
#include <string>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <chrono>
#include <algorithm>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cerrno>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_NO_STDIO
#include "stb_image_write.h"

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#include "stb_image.h"

// ---- config ----
static int RES_W = 320, RES_H = 180;
static int RENDER_FPS = 60;
static int STREAM_FPS = 30;
static int JPEG_QUALITY = 70;
static int THREADS = 0; // 0 = hardware_concurrency
static float FOV = 1.2217f; // 70 deg
static float YAW_SIGN = 1.0f, PITCH_SIGN = 1.0f;
static std::string FRAME_HOST = "127.0.0.1";
static int FRAME_PORT = 31337;
static int HTTP_PORT = 8080;
static std::string HTTP_HOST = "127.0.0.1";
static bool MOCK = false;
static float MAX_DIST = 48.0f;

// ---- palette: 16 kinds (R,G,B) ----
static const uint8_t PAL[16][3] = {
  {135,206,235}, // 0 air/sky
  {130,130,135}, // 1 stone
  {134, 96, 67}, // 2 dirt
  { 86,140, 57}, // 3 grass
  {102, 76, 46}, // 4 wood
  { 60,110, 46}, // 5 leaves
  {218,201,138}, // 6 sand
  { 54,108,200}, // 7 water
  { 80,200,210}, // 8 ore
  {220, 90, 20}, // 9 lava
  {235,240,245}, // 10 snow/ice
  {200,220,230}, // 11 glass
  {120,180, 80}, // 12 plant
  { 90, 40, 40}, // 13 netherrack
  { 40, 40, 45}, // 14 bedrock/obsidian
  {150,150,150}, // 15 generic
};
static const uint8_t SKY[3] = {135,206,235};

struct Ent { float rel[3]; uint8_t kind; std::string name; };
struct World {
  int ox=0, oy=0, oz=0, W=0, H=0, D=0;
  std::vector<uint8_t> grid;
  bool valid() const { return W>0 && H>0 && D>0 && grid.size()==(size_t)W*H*D; }
};

// ---- texture assets (built from the local client jar by scripts/build-mc-assets.py) ----
struct Tex { int w=0,h=0; std::vector<uint8_t> px; bool ok() const { return w>0&&h>0&&!px.empty(); } };
static std::string g_asset_dir = "data/mc";
static Tex g_atlas, g_ent[4]; // 1=mob, 2=player, 3=other
static bool g_tex_on=false;

static bool loadPng(const std::string& path, Tex& t) {
  FILE* f=fopen(path.c_str(),"rb");
  if(!f) return false;
  fseek(f,0,SEEK_END); long n=ftell(f); fseek(f,0,SEEK_SET);
  if(n<=0){ fclose(f); return false; }
  std::vector<uint8_t> buf((size_t)n);
  bool got = fread(buf.data(),1,(size_t)n,f)==(size_t)n;
  fclose(f);
  if(!got) return false;
  int w=0,h=0,c=0;
  stbi_uc* p=stbi_load_from_memory(buf.data(),(int)buf.size(),&w,&h,&c,4);
  if(!p) return false;
  t.w=w; t.h=h; t.px.assign(p, p + (size_t)w*(size_t)h*4);
  stbi_image_free(p);
  return true;
}
static void loadAssets() {
  if (loadPng(g_asset_dir+"/atlas.png", g_atlas)) g_tex_on = true;
  loadPng(g_asset_dir+"/ent_zombie.png", g_ent[1]);
  loadPng(g_asset_dir+"/ent_player.png", g_ent[2]);
  loadPng(g_asset_dir+"/ent_other.png", g_ent[3]);
  printf("[View] assets %s: atlas=%dx%d ents=%d/%d/%d\n", g_tex_on?"on":"palette",
         g_atlas.w,g_atlas.h, g_ent[1].ok()?1:0, g_ent[2].ok()?1:0, g_ent[3].ok()?1:0);
  fflush(stdout);
}

// daytime sky: horizon pale, zenith blue (approximates MC clear-weather sky)
static inline void skyColor(float ny, uint8_t out[3]) {
  const float horizon[3]={198,224,255}, zenith[3]={112,158,255};
  float e = ny>0 ? powf(ny,0.55f) : 0.0f;
  for (int i=0;i<3;i++) out[i]=(uint8_t)(horizon[i] + (zenith[i]-horizon[i])*e);
}
static inline bool isSkyPixel(const uint8_t* p) {
  return (int)p[2] > (int)p[0]+14 && p[2] > 150;
}
static inline void sampleAtlas(int tile, int u, int v, uint8_t out[4]) {
  if (tile<0) { out[0]=out[1]=out[2]=0; out[3]=0; return; }
  int cols=g_atlas.w/16;
  int x=(tile%cols)*16 + (u<0?0:(u>15?15:u));
  int y=(tile/cols)*16 + (v<0?0:(v>15?15:v));
  const uint8_t* p=&g_atlas.px[((size_t)y*(size_t)g_atlas.w + (size_t)x)*4];
  out[0]=p[0]; out[1]=p[1]; out[2]=p[2]; out[3]=p[3];
}
struct Pose {
  float eye[3] = {0, 0, 0};
  float yaw = 0, pitch = 0;
  std::vector<Ent> ents;
  bool valid = false;
};

static std::mutex g_world_mtx;
static World g_world;
static std::mutex g_pose_mtx;
static Pose g_target;      // latest from node
static Pose g_render_pose; // smoothed

static std::atomic<bool> g_running{true};
static std::atomic<int> g_fps{0};
static std::atomic<uint32_t> g_perc_seq{0};
static std::atomic<long long> g_last_packet_ms{0};
static std::atomic<long long> g_cells{0};

static std::mutex g_fb_mtx;
static std::vector<uint8_t> g_fb_a, g_fb_b; // rgb, double buffered
static std::vector<uint8_t>* g_ready = nullptr;
static int g_fbW = 0, g_fbH = 0;

static std::mutex g_jpeg_mtx;
static std::vector<uint8_t> g_jpeg;
static std::atomic<uint32_t> g_jpeg_seq{0};
static std::atomic<int> g_stream_clients{0};
static std::mutex g_enc_mtx;
static std::condition_variable g_enc_cv;
static std::vector<uint8_t> g_enc_in;
static bool g_enc_pending=false;
static int g_enc_w=320, g_enc_h=180, g_enc_q=70;
static std::atomic<long long> g_jpeg_ms{0};

// ---- perception summary sent back to Node ----
struct Perc {
  uint8_t free_center=0, free_left=0, free_right=0;
  uint8_t ground_pct=0, sky_pct=0;
  float forward_clear=MAX_DIST, nearest=MAX_DIST;
  int16_t target_sx=-1, target_sy=-1;
  uint8_t target_kind=0, target_dist=0;
  bool have_world=false, have_frame=false;
};
static std::mutex g_perc_mtx;
static Perc g_perc;

static long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::steady_clock::now().time_since_epoch()).count();
}

// ---- io helpers ----
static bool readn(int fd, void* buf, size_t n) {
  size_t got = 0; uint8_t* p = (uint8_t*)buf;
  while (got < n) {
    ssize_t r = recv(fd, p+got, n-got, 0);
    if (r <= 0) return false;
    got += (size_t)r;
  }
  return true;
}
static bool sendall(int fd, const void* buf, size_t n) {
  const uint8_t* p = (const uint8_t*)buf; size_t s = 0;
  while (s < n) {
    ssize_t w = send(fd, p+s, n-s, MSG_NOSIGNAL);
    if (w <= 0) return false;
    s += (size_t)w;
  }
  return true;
}
static uint16_t rdU16(const uint8_t* p){ return (uint16_t)(p[0]|(p[1]<<8)); }
static int16_t  rdI16(const uint8_t* p){ return (int16_t)(p[0]|(p[1]<<8)); }
static int32_t  rdI32(const uint8_t* p){ return (int32_t)((uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24)); }
static float    rdF32(const uint8_t* p){ uint32_t u=(uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24); float f; memcpy(&f,&u,4); return f; }

static void vcross(const float a[3],const float b[3],float o[3]){ o[0]=a[1]*b[2]-a[2]*b[1]; o[1]=a[2]*b[0]-a[0]*b[2]; o[2]=a[0]*b[1]-a[1]*b[0]; }
static float vdot(const float a[3],const float b[3]){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
static void vnorm(float a[3]){ float l=sqrtf(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]); if(l>1e-9f){a[0]/=l;a[1]/=l;a[2]/=l;} }

static inline uint8_t kindAt(const World& w, int x,int y,int z){
  if(x<0||y<0||z<0||x>=w.W||y>=w.H||z>=w.D) return 0;
  return w.grid[(size_t)x + (size_t)w.W*(size_t)z + (size_t)w.W*(size_t)w.D*(size_t)y];
}
static inline void setKind(World& w, int x,int y,int z, uint8_t k){
  if(x<0||y<0||z<0||x>=w.W||y>=w.H||z>=w.D) return;
  w.grid[(size_t)x + (size_t)w.W*(size_t)z + (size_t)w.W*(size_t)w.D*(size_t)y] = k;
}

// ---- camera basis, Minecraft convention (yaw 0 = +Z, positive yaw = -X) ----
static void cameraBasis(float yaw, float pitch, float fwd[3], float right[3], float up[3]) {
  yaw *= YAW_SIGN; pitch *= PITCH_SIGN;
  float cp = cosf(pitch);
  fwd[0] = -sinf(yaw)*cp; fwd[1] = -sinf(pitch); fwd[2] = cosf(yaw)*cp;
  vnorm(fwd);
  float upw[3] = {0,1,0};
  if (fabsf(vdot(fwd,upw)) > 0.99f) { upw[0]=0; upw[1]=0; upw[2]=1; }
  vcross(fwd, upw, right); vnorm(right);
  vcross(right, fwd, up); vnorm(up);
}

struct RayStats {
  float col_min[4096]; // per-column nearest hit (INF if none), capped to W
};

// ---- raycaster: render rows [y0,y1) ----
static void renderBand(const World& w, const Pose& pose, std::vector<uint8_t>& fb,
                       int W, int H, int y0, int y1, float* colmin) {
  float fwd[3], right[3], up[3];
  cameraBasis(pose.yaw, pose.pitch, fwd, right, up);
  float e[3] = { pose.eye[0]-w.ox, pose.eye[1]-w.oy, pose.eye[2]-w.oz };
  const float tanHalf = tanf(FOV*0.5f);
  const float aspect = (float)W/(float)H;
  const int cx0 = W*4/10, cx1 = W*6/10; // center corridor columns
  const int cy0 = H*35/100, cy1 = H*75/100; // corridor rows

  for (int py = y0; py < y1; ++py) {
    float ny = 1.0f - 2.0f*((float)py+0.5f)/(float)H;
    for (int px = 0; px < W; ++px) {
      float nx = 2.0f*((float)px+0.5f)/(float)W - 1.0f;
      float dir[3];
      for (int k=0;k<3;k++) dir[k] = fwd[k] + right[k]*nx*tanHalf*aspect + up[k]*ny*tanHalf;
      const float dirLen2 = dir[0]*dir[0] + dir[1]*dir[1] + dir[2]*dir[2];

      int ix=(int)floorf(e[0]), iy=(int)floorf(e[1]), iz=(int)floorf(e[2]);
      int stepX = dir[0]>0?1:(dir[0]<0?-1:1);
      int stepY = dir[1]>0?1:(dir[1]<0?-1:1);
      int stepZ = dir[2]>0?1:(dir[2]<0?-1:1);
      float dx = fabsf(dir[0])<1e-9f?1e-9f:fabsf(dir[0]);
      float dy = fabsf(dir[1])<1e-9f?1e-9f:fabsf(dir[1]);
      float dz = fabsf(dir[2])<1e-9f?1e-9f:fabsf(dir[2]);
      float tMaxX = (dir[0]>0 ? (ix+1-e[0]) : (e[0]-ix)) / dx;
      float tMaxY = (dir[1]>0 ? (iy+1-e[1]) : (e[1]-iy)) / dy;
      float tMaxZ = (dir[2]>0 ? (iz+1-e[2]) : (e[2]-iz)) / dz;
      float tDX = 1.0f/dx, tDY = 1.0f/dy, tDZ = 1.0f/dz;
      int lastAxis = -1;
      float t = 0.0f;
      bool hit = false;
      if (kindAt(w, ix, iy, iz) != 0) { hit = true; lastAxis = 1; }
      for (int step = 0; step < 192 && !hit; ++step) {
        if (tMaxX < tMaxY && tMaxX < tMaxZ) { ix += stepX; t = tMaxX; tMaxX += tDX; lastAxis = 0; }
        else if (tMaxY < tMaxZ)            { iy += stepY; t = tMaxY; tMaxY += tDY; lastAxis = 1; }
        else                                { iz += stepZ; t = tMaxZ; tMaxZ += tDZ; lastAxis = 2; }
        if (t*t > 2304.0f*dirLen2) break;
        if (ix<0 || ix>=w.W || iy<0 || iy>=w.H || iz<0 || iz>=w.D) break;
        if (kindAt(w, ix, iy, iz) != 0) hit = true;
      }
      uint8_t sky[3]; skyColor(ny, sky);
      float r = (float)sky[0], g = (float)sky[1], b = (float)sky[2];
      if (hit) {
        uint8_t k = kindAt(w, ix, iy, iz);
        float shade = (lastAxis==1) ? (stepY>0?0.5f:1.0f) : (lastAxis==0?0.62f:0.82f);
        if (g_tex_on) {
          int face = (lastAxis==1) ? ((stepY>0)?2:0) : 1;
          int tile = ((int)k-1)*3 + face;
          float hx = e[0]+dir[0]*t, hy = e[1]+dir[1]*t, hz = e[2]+dir[2]*t;
          float fu, fv;
          if (lastAxis==0)      { fu = hz-floorf(hz); fv = 1.0f-(hy-floorf(hy)); }
          else if (lastAxis==1) { fu = hx-floorf(hx); fv = hz-floorf(hz); }
          else                  { fu = hx-floorf(hx); fv = 1.0f-(hy-floorf(hy)); }
          uint8_t tx[4];
          sampleAtlas(tile, (int)(fu*16.0f), (int)(fv*16.0f), tx);
          float a = tx[3]/255.0f;
          r = r*(1.0f-a) + (float)tx[0]*shade*a;
          g = g*(1.0f-a) + (float)tx[1]*shade*a;
          b = b*(1.0f-a) + (float)tx[2]*shade*a;
        } else {
          const uint8_t* base = PAL[k < 16 ? k : 15];
          r = (float)base[0]*shade;
          g = (float)base[1]*shade;
          b = (float)base[2]*shade;
        }
        float dist = t*sqrtf(dirLen2);
        float fog = (dist-24.0f)/23.0f;
        fog = fog<0?0:(fog>1?1:fog);
        if (fog>0) {
          r += ((float)sky[0]-r)*fog;
          g += ((float)sky[1]-g)*fog;
          b += ((float)sky[2]-b)*fog;
        }
      }
      uint8_t rr=(uint8_t)(r<0?0:(r>255?255:r));
      uint8_t gg=(uint8_t)(g<0?0:(g>255?255:g));
      uint8_t bb=(uint8_t)(b<0?0:(b>255?255:b));
      size_t off = ((size_t)py*(size_t)W + (size_t)px)*3;
      fb[off] = rr; fb[off+1] = gg; fb[off+2] = bb;

      float colT = hit ? t : MAX_DIST;
      if (py >= cy0 && py < cy1 && colT < colmin[px]) colmin[px] = colT;
    }
  }
}

// ---- mock world + animation ----
static double g_mock_t = 0;
static World mockWorld() {
  World w; w.W=64; w.H=48; w.D=64;
  w.ox=-32; w.oy=60; w.oz=-32;
  w.grid.assign((size_t)w.W*w.H*w.D, 0);
  for (int x=0;x<w.W;++x) for (int z=0;z<w.D;++z) {
    setKind(w,x,2,z,3); setKind(w,x,1,z,2); setKind(w,x,0,z,1);
  }
  for (int y=3;y<8;++y) for (int x=8;x<12;++x) for (int z=8;z<12;++z) setKind(w,x,y,z,4);
  for (int y=3;y<16;++y) { setKind(w,20,y,20,4); setKind(w,40,y,10,1); setKind(w,10,y,40,6); }
  for (int y=3;y<6;++y) for (int x=28;x<34;++x) for (int z=28;z<34;++z) setKind(w,x,y,z,5);
  for (int x=24;x<28;++x) for (int z=24;z<28;++z) setKind(w,x,3,z,7);
  setKind(w,26,3,26,9);
  return w;
}
static Pose mockPose() {
  Pose p; p.valid = true;
  float yaw = (float)(g_mock_t * 0.35);
  p.eye[0] = 0.5f + 6.0f*sinf(yaw*0.7f);
  p.eye[1] = 63.0f + 1.62f; // mock origin oy=60, ground tops out at y=62
  p.eye[2] = 0.5f + 6.0f*cosf(yaw*0.7f);
  p.yaw = yaw; p.pitch = -0.12f;
  p.ents.push_back({{4.0f,0.0f,4.0f},2,"Steve"});
  p.ents.push_back({{-5.0f,0.0f,6.0f},1,"Zombie"});
  p.ents.push_back({{6.0f,1.0f,-4.0f},3,"item"});
  return p;
}

// ---- smoothing ----
static float angLerp(float a, float b, float f) {
  float d = b - a;
  while (d >  M_PI) d -= 2*M_PI;
  while (d < -M_PI) d += 2*M_PI;
  return a + d*f;
}
static void smoothPose(Pose& cur, const Pose& tgt, float f) {
  if (!tgt.valid) return;
  for (int k=0;k<3;k++) cur.eye[k] += (tgt.eye[k]-cur.eye[k])*f;
  cur.yaw = angLerp(cur.yaw, tgt.yaw, f);
  cur.pitch = angLerp(cur.pitch, tgt.pitch, f);
  cur.ents = tgt.ents;
  cur.valid = true;
}

// ---- encode helpers ----
struct JpegSink { std::vector<uint8_t>* out; };
static void jpegWrite(void* ctx, void* data, int size) {
  auto* sink = (JpegSink*)ctx;
  const uint8_t* p = (const uint8_t*)data;
  sink->out->insert(sink->out->end(), p, p+size);
}
static std::vector<uint8_t> encodeJpeg(const std::vector<uint8_t>& rgb, int W, int H, int q) {
  std::vector<uint8_t> out;
  out.reserve(16384);
  JpegSink sink{&out};
  stbi_write_jpg_to_func(jpegWrite, &sink, W, H, 3, rgb.data(), q);
  return out;
}
static void encoderLoop() {
  for (;;) {
    std::vector<uint8_t> buf; int W,H,Q;
    {
      std::unique_lock<std::mutex> lk(g_enc_mtx);
      g_enc_cv.wait(lk, []{ return g_enc_pending; });
      buf.swap(g_enc_in); W=g_enc_w; H=g_enc_h; Q=g_enc_q; g_enc_pending=false;
    }
    std::vector<uint8_t> j=encodeJpeg(buf,W,H,Q);
    std::lock_guard<std::mutex> lk(g_jpeg_mtx); g_jpeg.swap(j); g_jpeg_seq.fetch_add(1);
  }
}

static std::vector<uint8_t> encodeBmp(const std::vector<uint8_t>& rgb, int W, int H) {
  int rowSize = (W*3 + 3) & ~3;
  int pad = rowSize - W*3;
  size_t fileSize = 54 + (size_t)rowSize*H;
  std::vector<uint8_t> b(fileSize);
  b[0]='B'; b[1]='M';
  uint32_t fs=(uint32_t)fileSize; memcpy(b.data()+2,&fs,4);
  uint32_t off=54; memcpy(b.data()+10,&off,4);
  uint32_t hdr=40; memcpy(b.data()+14,&hdr,4);
  int32_t w=W,h=H; memcpy(b.data()+18,&w,4); memcpy(b.data()+22,&h,4);
  uint16_t planes=1, bpp=24; memcpy(b.data()+26,&planes,2); memcpy(b.data()+28,&bpp,2);
  uint32_t isz=(uint32_t)(rowSize*H); memcpy(b.data()+34,&isz,4);
  uint32_t ppm=2835; memcpy(b.data()+38,&ppm,4); memcpy(b.data()+42,&ppm,4);
  for (int y=0;y<H;++y) {
    uint8_t* dst = b.data()+54+(size_t)y*rowSize;
    const uint8_t* src = rgb.data()+(size_t)(H-1-y)*W*3;
    for (int x=0;x<W;++x) { dst[x*3]=src[x*3+2]; dst[x*3+1]=src[x*3+1]; dst[x*3+2]=src[x*3]; }
    for (int p=0;p<pad;++p) dst[W*3+p]=0;
  }
  return b;
}

// ---- PERC wire ----
// payload: seq u32, fps u16, flags u8, free_center u8, free_left u8,
// free_right u8, ground_pct u8, sky_pct u8, forward_clear f32, nearest f32,
// target_sx i16, target_sy i16, target_kind u8, target_dist u8, reserved u16
static bool sendPerc(int fd, const Perc& p, int fps) {
  uint8_t buf[36];
  memcpy(buf, "PERC", 4);
  uint32_t len = 28; memcpy(buf+4, &len, 4);
  uint32_t seq = g_perc_seq.fetch_add(1)+1; memcpy(buf+8, &seq, 4);
  uint16_t f = (uint16_t)(fps<0?0:(fps>65535?65535:fps)); memcpy(buf+12, &f, 2);
  buf[14] = (uint8_t)((p.have_world?1:0)|(p.have_frame?2:0));
  buf[15] = p.free_center; buf[16] = p.free_left; buf[17] = p.free_right;
  buf[18] = p.ground_pct; buf[19] = p.sky_pct;
  memcpy(buf+20, &p.forward_clear, 4);
  memcpy(buf+24, &p.nearest, 4);
  int16_t sx=p.target_sx, sy=p.target_sy;
  memcpy(buf+28, &sx, 2); memcpy(buf+30, &sy, 2);
  buf[32] = p.target_kind; buf[33] = p.target_dist;
  buf[34] = 0; buf[35] = 0;
  return sendall(fd, buf, 36);
}

// ---- frame socket client ----
static void frameClient() {
  while (g_running.load()) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { std::this_thread::sleep_for(std::chrono::seconds(1)); continue; }
    sockaddr_in addr{}; addr.sin_family=AF_INET; addr.sin_port=htons(FRAME_PORT);
    inet_pton(AF_INET, FRAME_HOST.c_str(), &addr.sin_addr);
    if (connect(fd,(sockaddr*)&addr,sizeof(addr)) != 0) {
      close(fd); std::this_thread::sleep_for(std::chrono::seconds(1)); continue;
    }
    int one=1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    printf("[View] connected to frame server %s:%d\n", FRAME_HOST.c_str(), FRAME_PORT);
    fflush(stdout);
    long long lastPerc = 0;
    while (g_running.load()) {
      uint8_t head[8];
      if (!readn(fd, head, 8)) break;
      uint32_t len = (uint32_t)head[4]|((uint32_t)head[5]<<8)|((uint32_t)head[6]<<16)|((uint32_t)head[7]<<24);
      if (len > 64u*1024u*1024u) break;
      std::vector<uint8_t> payload(len);
      if (len && !readn(fd, payload.data(), len)) break;
      g_last_packet_ms.store(now_ms());

      if (!memcmp(head, "VWLD", 4) && len >= 20) {
        World nw;
        nw.ox=rdI32(payload.data()); nw.oy=rdI32(payload.data()+4); nw.oz=rdI32(payload.data()+8);
        nw.W=rdU16(payload.data()+12); nw.H=rdU16(payload.data()+14); nw.D=rdU16(payload.data()+16);
        size_t cells=(size_t)nw.W*nw.H*nw.D;
        if (nw.W<=0||nw.H<=0||nw.D<=0||nw.W>512||nw.H>512||nw.D>512||cells>32u*1024u*1024u) continue;
        if (len < 20 + cells) continue;
        nw.grid.assign(payload.begin()+20, payload.begin()+20+(ptrdiff_t)cells);
        { std::lock_guard<std::mutex> lk(g_world_mtx); g_world = std::move(nw); }
        g_cells.store((long long)cells);
        printf("[View] world %dx%dx%d @ %d,%d,%d\n", g_world.W,g_world.H,g_world.D,g_world.ox,g_world.oy,g_world.oz);
        fflush(stdout);
      } else if (!memcmp(head, "VBLK", 4) && len >= 2) {
        uint16_t count = rdU16(payload.data());
        size_t need = 2 + (size_t)count*7;
        if (len < need) continue;
        std::lock_guard<std::mutex> lk(g_world_mtx);
        if (!g_world.valid()) continue;
        const uint8_t* p = payload.data()+2;
        for (uint16_t i=0;i<count;++i, p+=7) {
          int rx=rdI16(p), ry=rdI16(p+2), rz=rdI16(p+4);
          setKind(g_world, rx, ry, rz, p[6]);
        }
      } else if (!memcmp(head, "VFRM", 4) && len >= 22) {
        Pose np;
        np.eye[0]=rdF32(payload.data()); np.eye[1]=rdF32(payload.data()+4); np.eye[2]=rdF32(payload.data()+8);
        np.yaw=rdF32(payload.data()+12); np.pitch=rdF32(payload.data()+16);
        uint16_t ec=rdU16(payload.data()+20);
        size_t off=22;
        for (uint16_t i=0;i<ec && off+13<=len;++i) {
          Ent e;
          e.rel[0]=rdF32(payload.data()+off); e.rel[1]=rdF32(payload.data()+off+4); e.rel[2]=rdF32(payload.data()+off+8);
          e.kind=payload[off+12];
          uint8_t nl=payload[off+13];
          off += 14;
          if (nl>0 && off+nl<=len) { e.name.assign((const char*)payload.data()+off, nl); off+=nl; }
          np.ents.push_back(std::move(e));
        }
        np.valid=true;
        { std::lock_guard<std::mutex> lk(g_pose_mtx); g_target = std::move(np); }
      }
      long long t = now_ms();
      if (t-lastPerc >= 100) {
        Perc p; { std::lock_guard<std::mutex> lk(g_perc_mtx); p = g_perc; }
        if (!sendPerc(fd, p, g_fps.load())) break;
        lastPerc = t;
      }
    }
    close(fd);
    printf("[View] frame server disconnected; retrying\n");
    fflush(stdout);
    std::this_thread::sleep_for(std::chrono::seconds(1));
  }
}

// ---- entity billboards ----
static void drawEntities(uint8_t* fb, int W, int H, const Pose& pose, const float* colmin) {
  float fwd[3], right[3], up[3];
  cameraBasis(pose.yaw, pose.pitch, fwd, right, up);
  float focal = ((float)W*0.5f)/tanf(FOV*0.5f);
  std::vector<std::pair<float,const Ent*>> order;
  order.reserve(pose.ents.size());
  for (const Ent& en : pose.ents) {
    float fd = vdot(en.rel, fwd);
    if (fd <= 0.3f) continue;
    float dist = sqrtf(en.rel[0]*en.rel[0]+en.rel[1]*en.rel[1]+en.rel[2]*en.rel[2]);
    order.push_back({dist,&en});
  }
  std::sort(order.begin(), order.end(),
            [](const std::pair<float,const Ent*>& a, const std::pair<float,const Ent*>& b){
              return a.first > b.first; });
  uint8_t fogc[3]; skyColor(0.0f, fogc);
  for (auto& [dist, enp] : order) {
    const Ent& en = *enp;
    float fd = vdot(en.rel, fwd);
    float rd = vdot(en.rel, right);
    float ud = vdot(en.rel, up);
    int sx = (int)((float)W*0.5f + rd/fd*focal);
    if (sx < 0 || sx >= W) continue;
    // occluded by the nearest block the center column already hit
    if (colmin && dist > colmin[sx]*1.35f + 0.6f) continue;
    float height = (en.kind==3) ? 0.9f : 1.8f;
    int syFeet = (int)((float)H*0.5f - ud/fd*focal);
    int syHead = (int)((float)H*0.5f - (ud+height)/fd*focal);
    int yTop = std::min(syHead,syFeet), yBot = std::max(syHead,syFeet);
    int hp = std::max(1, yBot-yTop+1);
    int wp = std::max(1, hp/2);
    int x0 = sx - wp/2;
    const Tex* t = (en.kind==1) ? &g_ent[1] : (en.kind==2 ? &g_ent[2] : &g_ent[3]);
    bool have = t->ok();
    uint8_t ec[3];
    if (en.kind==2) { ec[0]=60; ec[1]=220; ec[2]=80; }
    else if (en.kind==1) { ec[0]=220; ec[1]=60; ec[2]=60; }
    else { ec[0]=230; ec[1]=200; ec[2]=60; }
    float fog = (dist-28.0f)/20.0f;
    fog = fog<0?0:(fog>1?1:fog);
    for (int yy=yTop; yy<=yBot; ++yy) {
      if (yy<0||yy>=H) continue;
      int v = (int)((float)(yy-yTop)/(float)hp*32.0f);
      if (v>31) v=31;
      for (int xx=x0; xx<x0+wp; ++xx) {
        if (xx<0||xx>=W) continue;
        uint8_t cr,cg,cb;
        if (have) {
          int u = (int)((float)(xx-x0)/(float)wp*16.0f);
          if (u>15) u=15;
          const uint8_t* p=&t->px[((size_t)v*(size_t)t->w + (size_t)u)*4];
          if (p[3] < 96) continue;
          cr=p[0]; cg=p[1]; cb=p[2];
        } else {
          cr=ec[0]; cg=ec[1]; cb=ec[2];
        }
        size_t off=((size_t)yy*(size_t)W+(size_t)xx)*3;
        fb[off]  =(uint8_t)(cr + ((int)fogc[0]-cr)*fog);
        fb[off+1]=(uint8_t)(cg + ((int)fogc[1]-cg)*fog);
        fb[off+2]=(uint8_t)(cb + ((int)fogc[2]-cb)*fog);
      }
    }
  }
}

// ---- crosshair ----
static void drawCrosshair(uint8_t* fb, int W, int H) {
  int cx=W/2, cy=H/2;
  for (int d=-3; d<=3; ++d) {
    int px=cx+d, py=cy;
    if (px>=0&&px<W) { size_t o=((size_t)py*(size_t)W+(size_t)px)*3; fb[o]=20; fb[o+1]=20; fb[o+2]=20; }
    px=cx; py=cy+d;
    if (py>=0&&py<H) { size_t o=((size_t)py*(size_t)W+(size_t)px)*3; fb[o]=20; fb[o+1]=20; fb[o+2]=20; }
  }
  for (int d=-2; d<=2; ++d) {
    if (d==0) continue;
    int px=cx+d, py=cy;
    size_t o=((size_t)py*(size_t)W+(size_t)px)*3; fb[o]=240; fb[o+1]=240; fb[o+2]=240;
    px=cx; py=cy+d;
    o=((size_t)py*(size_t)W+(size_t)px)*3; fb[o]=240; fb[o+1]=240; fb[o+2]=240;
  }
}

// ---- entity on-screen test for perception ----
static void perceiveEntities(const Pose& pose, int W, int H, Perc& p) {
  if (!pose.valid || pose.ents.empty()) return;
  float fwd[3], right[3], up[3];
  cameraBasis(pose.yaw, pose.pitch, fwd, right, up);
  float focal = ((float)W*0.5f)/tanf(FOV*0.5f);
  bool found=false; float best=1e9f;
  for (const Ent& en : pose.ents) {
    float fd = vdot(en.rel, fwd);
    if (fd <= 0.5f) continue;
    float rd = vdot(en.rel, right);
    float ud = vdot(en.rel, up) + 0.9f; // aim at body centre, not feet
    int sx = (int)((float)W*0.5f + rd/fd*focal);
    int sy = (int)((float)H*0.5f - ud/fd*focal);
    if (sx<0||sy<0||sx>=W||sy>=H) continue;
    float dist = sqrtf(en.rel[0]*en.rel[0]+en.rel[1]*en.rel[1]+en.rel[2]*en.rel[2]);
    if (dist < best) {
      best = dist; found = true;
      p.target_sx=(int16_t)sx; p.target_sy=(int16_t)sy;
      p.target_kind = en.kind ? en.kind : 3;
      p.target_dist = (uint8_t)std::min(255.0f, dist);
    }
  }
  if (!found) { p.target_sx=-1; p.target_sy=-1; p.target_kind=0; p.target_dist=0; }
}

static void computePerception(const RayStats& st, const Pose& pose, int W, int H, Perc& p) {
  int cx0=W*4/10, cx1=W*6/10;
  auto freeFrac = [&](int x0,int x1)->int {
    int free=0, n=0;
    for (int x=x0;x<x1;++x) { n++; if (st.col_min[x] > 3.0f) free++; }
    return n? (free*100/n) : 0;
  };
  p.free_center=(uint8_t)freeFrac(cx0,cx1);
  p.free_left=(uint8_t)freeFrac(0,W/3);
  p.free_right=(uint8_t)freeFrac(W*2/3,W);
  float mid=MAX_DIST;
  for (int x=W*47/100;x<W*53/100;++x) mid=std::min(mid, st.col_min[x]);
  p.forward_clear = std::min(mid, MAX_DIST);
  float near=MAX_DIST;
  for (int x=cx0;x<cx1;++x) near=std::min(near, st.col_min[x]);
  p.nearest = std::min(near, MAX_DIST);
  // lower band coverage from framebuffer
  size_t lowerHit=0, lowerN=0, skyHit=0, skyN=0;
  std::lock_guard<std::mutex> lk(g_fb_mtx);
  const std::vector<uint8_t>* fb = g_ready;
  if (fb && (int)fb->size() >= W*H*3) {
    const uint8_t* d = fb->data();
    for (int y=H*2/3;y<H;y+=2) for (int x=0;x<W;x+=2) {
      const uint8_t* px=&d[((size_t)y*W+x)*3]; lowerN++;
      if (!isSkyPixel(px)) lowerHit++;
    }
    for (int y=0;y<H/3;y+=2) for (int x=0;x<W;x+=2) {
      const uint8_t* px=&d[((size_t)y*W+x)*3]; skyN++;
      if (isSkyPixel(px)) skyHit++;
    }
    p.ground_pct=(uint8_t)(lowerN?(lowerHit*100/lowerN):0);
    p.sky_pct=(uint8_t)(skyN?(skyHit*100/skyN):0);
  }
  p.have_frame=pose.valid;
  p.have_world=g_world.valid();
  perceiveEntities(pose, W, H, p);
}

// ---- render loop ----
static void renderer() {
  int W=RES_W,H=RES_H;
  std::vector<uint8_t> fb((size_t)W*H*3);
  g_fb_a.resize((size_t)W*H*3);
  g_fb_b.resize((size_t)W*H*3);
  g_fbW=W; g_fbH=H;
  int hw=THREADS>0?THREADS:(int)std::thread::hardware_concurrency();
  if (hw<1) hw=1; if (hw>16) hw=16;
  std::vector<std::thread> pool(hw);
  RayStats stats;
  long long last=now_ms(), lastJpeg=0;
  int frames=0;
  auto nextFrame=std::chrono::steady_clock::now();

  while (g_running.load()) {
    long long frameStart=now_ms();
    if (MOCK) {
      World mw=mockWorld();
      Pose mp=mockPose();
      { std::lock_guard<std::mutex> lk(g_world_mtx); g_world=std::move(mw); }
      { std::lock_guard<std::mutex> lk(g_pose_mtx); g_target=mp; }
      g_mock_t += 0.016;
    }
    {
      std::lock_guard<std::mutex> lk(g_pose_mtx);
      smoothPose(g_render_pose, g_target, 0.35f);
    }
    Pose pose; Pose target;
    { std::lock_guard<std::mutex> lk(g_pose_mtx); pose=g_render_pose; target=g_target; }
    if (!pose.valid) {
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      continue;
    }
    // bounds: only render if origin sane (grid cells cap)
    const int cols = std::min(W,4096);
    std::fill(stats.col_min, stats.col_min + cols, MAX_DIST);
    std::lock_guard<std::mutex> wl(g_world_mtx);
    const World& world = g_world;
    if (!world.valid()) { std::this_thread::sleep_for(std::chrono::milliseconds(20)); continue; }
    {
      std::atomic<int> next_strip{0};
      const int stripH=4, nstrips=(H+stripH-1)/stripH;
      std::mutex stats_mtx;
      auto worker=[&]{
        std::vector<float> local((size_t)cols, MAX_DIST);
        for (;;) {
          int si=next_strip.fetch_add(1);
          if (si>=nstrips) break;
          int y0=si*stripH, y1=std::min(H,y0+stripH);
          renderBand(world, pose, fb, W, H, y0, y1, local.data());
        }
        std::lock_guard<std::mutex> lk(stats_mtx);
        for (int x=0;x<cols;++x) if (local[x] < stats.col_min[x]) stats.col_min[x]=local[x];
      };
      for (int t=0;t<hw;++t) pool[t]=std::thread(worker);
      for (auto& th : pool) th.join();
    }
    drawEntities(fb.data(), W, H, pose, stats.col_min);
    drawCrosshair(fb.data(), W, H);
    // swap framebuffer
    { std::lock_guard<std::mutex> lk(g_fb_mtx); g_fb_a.swap(fb); g_ready=&g_fb_a; }
    frames++;

    Perc p;
    { std::lock_guard<std::mutex> lk(g_perc_mtx); computePerception(stats, pose, W, H, p); g_perc=p; }
    // jpeg for stream
    long long t=now_ms();
    if (STREAM_FPS>0 && t-lastJpeg >= 1000/STREAM_FPS) {
      if (g_stream_clients.load() > 0) {
        std::vector<uint8_t> snapshot;
        { std::lock_guard<std::mutex> lk(g_fb_mtx); if (g_ready) snapshot=*g_ready; }
        if (!snapshot.empty()) {
          { std::lock_guard<std::mutex> lk(g_enc_mtx); g_enc_in.swap(snapshot); g_enc_w=W; g_enc_h=H; g_enc_q=JPEG_QUALITY; g_enc_pending=true; }
          g_enc_cv.notify_one();
        }
      }
      lastJpeg=t;
    }
    if (t-last >= 1000) { g_fps.store((int)(frames*1000/(t-last))); frames=0; last=t; }
    // frame pacing: absolute deadlines, no cumulative sleep drift
    nextFrame += std::chrono::microseconds(1000000/std::max(1,RENDER_FPS));
    auto nowc=std::chrono::steady_clock::now();
    if (nextFrame>nowc) std::this_thread::sleep_until(nextFrame);
    else nextFrame=nowc;
  }
}

// ---- HTTP ----
static void httpReply(int fd,int code,const char* ct,const uint8_t* body,size_t len) {
  char head[320];
  int n=snprintf(head,sizeof(head),
    "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
    "Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
    code, code==200?"OK":"ERR", ct, len);
  sendall(fd,(uint8_t*)head,(size_t)n);
  if(body && len) sendall(fd,body,len);
}
struct StreamClient { StreamClient(){g_stream_clients.fetch_add(1);} ~StreamClient(){g_stream_clients.fetch_sub(1);} };

static void httpStream(int fd) {
  StreamClient client;
  const char* hdr =
    "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n"
    "Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n";
  if (!sendall(fd,(uint8_t*)hdr,strlen(hdr))) return;
  uint32_t seen=g_jpeg_seq.load();
  while (g_running.load()) {
    for (int i=0;i<50 && g_jpeg_seq.load()==seen;++i)
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    if (g_jpeg_seq.load()==seen) { std::this_thread::sleep_for(std::chrono::milliseconds(50)); continue; }
    seen=g_jpeg_seq.load();
    std::vector<uint8_t> j;
    { std::lock_guard<std::mutex> lk(g_jpeg_mtx); j=g_jpeg; }
    if (j.empty()) continue;
    char part[128];
    int n=snprintf(part,sizeof(part),"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %zu\r\n\r\n",j.size());
    if (!sendall(fd,part,(size_t)n) || !sendall(fd,j.data(),j.size()) || !sendall(fd,(uint8_t*)"\r\n",2)) return;
  }
}
static void httpServer() {
  int srv=socket(AF_INET,SOCK_STREAM,0);
  if (srv<0) return;
  int one=1; setsockopt(srv,SOL_SOCKET,SO_REUSEADDR,&one,sizeof(one));
  sockaddr_in addr{}; addr.sin_family=AF_INET; addr.sin_port=htons(HTTP_PORT);
  if (inet_pton(AF_INET,HTTP_HOST.c_str(),&addr.sin_addr)!=1) {
    fprintf(stderr,"[View] invalid HTTP bind address: %s\n",HTTP_HOST.c_str()); close(srv); return;
  }
  if (bind(srv,(sockaddr*)&addr,sizeof(addr))!=0) {
    fprintf(stderr,"[View] bind %d failed: %s\n",HTTP_PORT,strerror(errno)); return;
  }
  listen(srv,16);
  printf("[View] HTTP viewer on http://%s:%d/ (mock=%d)\n", HTTP_HOST.c_str(), HTTP_PORT, MOCK?1:0);
  fflush(stdout);
  while (g_running.load()) {
    int c=accept(srv,nullptr,nullptr);
    if (c<0) continue;
    std::thread([c]{
      char buf[1024];
      ssize_t r=recv(c,buf,sizeof(buf)-1,0);
      if (r<=0) { close(c); return; }
      buf[r]=0;
      char path[256]="";
      sscanf(buf,"GET %255s",path);
      if (!strcmp(path,"/") || !strncmp(path,"/?",2)) {
        const char* html =
          "<!doctype html><html><head><meta charset=utf8><title>Bot View</title>"
          "<style>html,body{margin:0;height:100%;background:#000;color:#e8e8e8;font:12px ui-monospace,monospace;overflow:hidden}"
          "#v{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;background:#000;display:block}"
          "#s{position:fixed;top:6px;left:8px;text-shadow:0 0 4px #000;white-space:pre;pointer-events:none}"
          "#f{position:fixed;right:8px;top:6px;background:#000a;color:#ddd;border:1px solid #444;padding:4px 8px;font:inherit;cursor:pointer}</style></head>"
          "<body><img id=v src=/stream><div id=s></div><button id=f>fullscreen</button>"
          "<script>const v=document.getElementById('v'),s=document.getElementById('s'),f=document.getElementById('f');"
          "function full(){if(!document.fullscreenElement){document.documentElement.requestFullscreen().catch(()=>{});}else{document.exitFullscreen();}}"
          "f.onclick=full;addEventListener('keydown',e=>{if(e.key==='f'||e.key==='F')full();});"
          "setInterval(()=>{fetch('/state').then(r=>r.text()).then(t=>s.textContent=t).catch(()=>{});},1000);"
          "</script></body></html>";
        httpReply(c,200,"text/html; charset=utf8",(const uint8_t*)html,strlen(html));
      } else if (!strcmp(path,"/stream")) {
        httpStream(c);
      } else if (!strncmp(path,"/frame.bmp",10)) {
        std::vector<uint8_t> rgb; int W,H;
        { std::lock_guard<std::mutex> lk(g_fb_mtx); if(g_ready){ rgb=*g_ready; W=g_fbW; H=g_fbH; } }
        if (rgb.empty()) { httpReply(c,200,"image/bmp",nullptr,0); }
        else { auto bmp=encodeBmp(rgb,W,H); httpReply(c,200,"image/bmp",bmp.data(),bmp.size()); }
      } else if (!strncmp(path,"/frame",6)) {
        std::vector<uint8_t> rgb; int W,H;
        { std::lock_guard<std::mutex> lk(g_fb_mtx); if(g_ready){ rgb=*g_ready; W=g_fbW; H=g_fbH; } }
        if (rgb.empty()) { httpReply(c,200,"image/jpeg",nullptr,0); }
        else { auto j=encodeJpeg(rgb,W,H,JPEG_QUALITY); httpReply(c,200,"image/jpeg",j.data(),j.size()); }
      } else if (!strcmp(path,"/state")) {
        Perc p; { std::lock_guard<std::mutex> lk(g_perc_mtx); p=g_perc; }
        Pose pose; { std::lock_guard<std::mutex> lk(g_pose_mtx); pose=g_render_pose; }
        char js[512];
        int n=snprintf(js,sizeof(js),
          "fps=%d cells=%lld ents=%zu eye=%.1f,%.1f,%.1f yaw=%.2f pitch=%.2f\n"
          "free c/l/r=%d/%d/%d ground=%d sky=%d fwd_clear=%.1f nearest=%.1f target=%d@(%d,%d) dist=%d\n"
          "packet_age_ms=%lld",
          g_fps.load(), g_cells.load(), pose.ents.size(), pose.eye[0],pose.eye[1],pose.eye[2],pose.yaw,pose.pitch,
          p.free_center,p.free_left,p.free_right,p.ground_pct,p.sky_pct,p.forward_clear,p.nearest,
          p.target_kind,p.target_sx,p.target_sy,p.target_dist,
          g_last_packet_ms.load()? now_ms()-g_last_packet_ms.load():-1);
        httpReply(c,200,"text/plain",(const uint8_t*)js,(size_t)n);
      } else if (!strcmp(path,"/state.json")) {
        Perc p; { std::lock_guard<std::mutex> lk(g_perc_mtx); p=g_perc; }
        Pose pose; { std::lock_guard<std::mutex> lk(g_pose_mtx); pose=g_render_pose; }
        World world; { std::lock_guard<std::mutex> lk(g_world_mtx); world=g_world; }
        char js[1200];
        int n=snprintf(js,sizeof(js),
          "{\"fps\":%d,\"cells\":%lld,\"entities\":%zu,"
          "\"eye\":[%.3f,%.3f,%.3f],\"yaw\":%.6f,\"pitch\":%.6f,"
          "\"world\":[%d,%d,%d],\"free\":{\"center\":%u,\"left\":%u,\"right\":%u},"
          "\"groundPct\":%u,\"skyPct\":%u,\"forwardClear\":%.3f,\"nearestObstacle\":%.3f,"
          "\"target\":{\"kind\":%u,\"screenX\":%d,\"screenY\":%d,\"distance\":%u},"
          "\"haveWorld\":%s,\"haveFrame\":%s,\"packetAgeMs\":%lld}",
          g_fps.load(),g_cells.load(),pose.ents.size(),
          pose.eye[0],pose.eye[1],pose.eye[2],pose.yaw,pose.pitch,
          world.W,world.H,world.D,
          (unsigned)p.free_center,(unsigned)p.free_left,(unsigned)p.free_right,
          (unsigned)p.ground_pct,(unsigned)p.sky_pct,p.forward_clear,p.nearest,
          (unsigned)p.target_kind,(int)p.target_sx,(int)p.target_sy,(unsigned)p.target_dist,
          p.have_world?"true":"false",p.have_frame?"true":"false",
          g_last_packet_ms.load()? now_ms()-g_last_packet_ms.load():-1LL);
        if (n<0 || (size_t)n>=sizeof(js)) {
          httpReply(c,500,"text/plain",(const uint8_t*)"state too large",15);
        } else {
          httpReply(c,200,"application/json; charset=utf-8",(const uint8_t*)js,(size_t)n);
        }
      } else {
        httpReply(c,404,"text/plain",(const uint8_t*)"404",3);
      }
      close(c);
    }).detach();
  }
  close(srv);
}

// ---- bench / selftest ----
static void bench(double seconds) {
  World w=mockWorld();
  Pose p=mockPose();
  int W=RES_W,H=RES_H;
  int hw=THREADS>0?THREADS:(int)std::thread::hardware_concurrency(); if(hw<1)hw=1; if(hw>16)hw=16;
  std::vector<uint8_t> fb((size_t)W*H*3);
  RayStats st;
  auto t0=std::chrono::steady_clock::now();
  long long frames=0;
  std::vector<std::thread> pool(hw);
  while (std::chrono::duration<double>(std::chrono::steady_clock::now()-t0).count() < seconds) {
    std::fill(st.col_min, st.col_min+std::min(W,4096), MAX_DIST);
    for (int t=0;t<hw;++t) { int y0=H*t/hw,y1=H*(t+1)/hw;
      pool[t]=std::thread([&,y0,y1]{ renderBand(w,p,fb,W,H,y0,y1,st.col_min); }); }
    for (auto& th:pool) th.join();
    frames++;
  }
  double dt=std::chrono::duration<double>(std::chrono::steady_clock::now()-t0).count();
  printf("bench: %lld frames in %.2fs = %.1f fps at %dx%d with %d threads\n",
         frames, dt, frames/dt, W,H,hw);
}
static int selftest() {
  World w=mockWorld();
  Pose p=mockPose();
  int W=RES_W,H=RES_H;
  std::vector<uint8_t> fb((size_t)W*H*3, 0);
  RayStats st; std::fill(st.col_min, st.col_min+std::min(W,4096), MAX_DIST);
  int hw=THREADS>0?THREADS:2; if(hw>4)hw=4;
  std::vector<std::thread> pool(hw);
  for (int t=0;t<hw;++t){ int y0=H*t/hw,y1=H*(t+1)/hw;
    pool[t]=std::thread([&,y0,y1]{ renderBand(w,p,fb,W,H,y0,y1,st.col_min); }); }
  for (auto& th:pool) th.join();
  drawEntities(fb.data(),W,H,p,nullptr);
  drawCrosshair(fb.data(),W,H);
  int distinct=0, first=fb.empty()?-1:fb[0], sky=0, solid=0;
  for (size_t i=0;i<fb.size();i+=3){
    if (fb[i]!=first) distinct++;
    uint8_t px[3]={fb[i],fb[i+1],fb[i+2]};
    if (isSkyPixel(px)) sky++; else solid++;
  }
  int mid=W/2;
  printf("selftest: %dx%d pixels=%zu solid=%d sky=%d distinct_start=%d center_col_min=%.2f\n",
         W,H,fb.size()/3, solid, sky, distinct, st.col_min[mid]);
  if (solid<=0 || st.col_min[mid]>=MAX_DIST) { printf("selftest: FAIL\n"); return 1; }
  std::vector<uint8_t> j=encodeJpeg(fb,W,H,JPEG_QUALITY);
  printf("selftest: jpeg=%zu bytes\nselftest: OK\n", j.size());
  return 0;
}

int main(int argc,char**argv){
  bool doBench=false; double benchSec=5; bool doSelf=false;
  for (int i=1;i<argc;++i){
    std::string a=argv[i];
    if (a=="--mock") MOCK=true;
    else if (a=="--frame-host"&&i+1<argc) FRAME_HOST=argv[++i];
    else if (a=="--frame-port"&&i+1<argc) FRAME_PORT=atoi(argv[++i]);
    else if (a=="--http-port"&&i+1<argc) HTTP_PORT=atoi(argv[++i]);
    else if (a=="--http-host"&&i+1<argc) HTTP_HOST=argv[++i];
    else if (a=="--w"&&i+1<argc) RES_W=atoi(argv[++i]);
    else if (a=="--h"&&i+1<argc) RES_H=atoi(argv[++i]);
    else if (a=="--threads"&&i+1<argc) THREADS=atoi(argv[++i]);
    else if (a=="--fps"&&i+1<argc) RENDER_FPS=atoi(argv[++i]);
    else if (a=="--stream-fps"&&i+1<argc) STREAM_FPS=atoi(argv[++i]);
    else if (a=="--quality"&&i+1<argc) JPEG_QUALITY=atoi(argv[++i]);
    else if (a=="--maxdist"&&i+1<argc) MAX_DIST=(float)atof(argv[++i]);
    else if (a=="--yaw-sign"&&i+1<argc) YAW_SIGN=(float)atof(argv[++i]);
    else if (a=="--pitch-sign"&&i+1<argc) PITCH_SIGN=(float)atof(argv[++i]);
    else if (a=="--bench"&&i+1<argc) { doBench=true; benchSec=atof(argv[++i]); }
    else if (a=="--assets"&&i+1<argc) g_asset_dir=argv[++i];
    else if (a=="--selftest") doSelf=true;
  }
  if (const char* e=getenv("VIEW_YAW_SIGN")) YAW_SIGN=(float)atof(e);
  if (const char* e=getenv("VIEW_PITCH_SIGN")) PITCH_SIGN=(float)atof(e);
  if (RES_W<64||RES_W>1024) RES_W=320;
  if (RES_H<64||RES_H>1024) RES_H=180;
  if (RENDER_FPS<1) RENDER_FPS=60;
  if (STREAM_FPS<0) STREAM_FPS=30;
  if (JPEG_QUALITY<1) JPEG_QUALITY=70;
  if (MAX_DIST<8) MAX_DIST=48;
  loadAssets();

  if (doSelf) return selftest();
  if (doBench) { bench(benchSec); return 0; }

  printf("[View] bot_view v2 res=%dx%d fps=%d stream=%d threads=%d frame=%s:%d http=%s:%d mock=%d\n",
         RES_W,RES_H,RENDER_FPS,STREAM_FPS,THREADS,FRAME_HOST.c_str(),FRAME_PORT,HTTP_HOST.c_str(),HTTP_PORT,MOCK?1:0);
  fflush(stdout);
  std::thread(httpServer).detach();
  std::thread(encoderLoop).detach();
  std::thread(renderer).detach();
  if (!MOCK) {
    std::thread(frameClient).detach();
  } else {
    // in mock mode the renderer feeds itself; nothing else to do
  }
  while (g_running.load()) std::this_thread::sleep_for(std::chrono::seconds(1));
  return 0;
}
