# 运行目录配置

本项目分为网页与接口服务、动画服务两部分。先配置服务凭据并测试语音，再安装动画依赖，有助于分别定位问题。

## 网页与接口服务

在 `app/` 目录使用 `pnpm install`、`pnpm build`、`pnpm start`。Node.js 需要支持 `import.meta.dirname`；建议使用当前受支持的 Node.js LTS 版本。

打开页面的服务设置，填写自己的 DeepSeek 与火山引擎参数并测试。公开源码不包含现成的服务账号或凭据。语音合成的音色参数应使用你的账号已开通的值。

本地配置与本机加密密钥都写入 `app/data/`，该目录被 Git 忽略。不要将旧项目的配置文件复制进公开提交；不同副本的数据与密钥应各自保留。

## 动画服务

先阅读 [UPSTREAM.md](UPSTREAM.md)，安装两个上游项目并应用已检查的适配补丁。默认目录如下：

```text
项目根目录/
  animation/
    LivePortrait/                 # 按上游说明安装，Git 忽略
    MuseTalk/                     # 按上游说明安装，Git 忽略
    service/animation_service.py
  runtime/                        # Git 忽略
    envs/
      musetalk/python.exe
      liveportrait/python.exe
    ffmpeg/ffmpeg-master-latest-win64-gpl/bin/
    renders/                      # 运行时生成
    data/characters/              # 运行时生成
```

模型权重放到各上游项目要求的位置。Python 环境应按对应上游版本安装，动画衔接服务还使用 FastAPI、PyTorch、Transformers、NumPy 和 OpenCV 等依赖；当前发布不提供经过全新环境验证的统一锁定环境。

如果沿用上面的目录，默认运行路径以本项目根目录为基准。如果使用其他目录，在启动 Node.js 服务前设置相应环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `NIGHT_VOYAGE_ANIMATION_PYTHON` | 用于启动动画服务的 Python 可执行文件 |
| `NIGHT_VOYAGE_RUNTIME_ROOT` | Python 动画服务使用的运行环境与数据根目录 |
| `NIGHT_VOYAGE_RENDER_DIR` | Node.js 读取生成视频的目录，需与 Python 的 `renders/` 目录一致 |

自定义运行根目录时，请同时核对上面三项，尤其是视频输出目录。默认本地动画服务地址为 `http://127.0.0.1:3011`。

公开示例头像是 SVG 占位图，不用于模型推理。请在界面中新建角色，上传自己准备的人像图片，再体验动画回复。模型加载和视频生成需要等待；当前不承诺特定显卡上的生成速度或显存峰值。

## 验证范围

当前已完成代码与前端构建检查、本地页面和空配置接口检查，以及用合成测试数据对公开版密钥模块的验证。真实服务凭据、云端调用与 GPU 模型推理没有参与本次发布准备检查。
