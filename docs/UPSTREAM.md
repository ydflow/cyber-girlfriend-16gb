# 动画依赖

大型模型、运行环境和第三方仓库不包含在本仓库中。

| 依赖 | 检查时的上游版本 | 本项目改动 |
| --- | --- | --- |
| [LivePortrait](https://github.com/KlingAIResearch/LivePortrait) | `9b294b3d0536135442ea73cb01e6cb3ca7029dd3` | `patches/liveportrait-local.patch` |
| [MuseTalk](https://github.com/TMElyralab/MuseTalk) | `0a89dec45a0192b824e3cf4daf96c239440c5ed8` | `patches/musetalk-local.patch` |

请先按上游项目说明安装依赖并下载模型，再检出表中版本、应用对应补丁。补丁保留本项目已经存在但尚未提交的本地适配；公开发布前经过敏感模式扫描，但仍建议在应用前自行审阅。

在本仓库根目录准备代码：

```powershell
git clone https://github.com/KlingAIResearch/LivePortrait animation/LivePortrait
git -C animation/LivePortrait checkout 9b294b3d0536135442ea73cb01e6cb3ca7029dd3
git -C animation/LivePortrait apply ../../patches/liveportrait-local.patch

git clone https://github.com/TMElyralab/MuseTalk animation/MuseTalk
git -C animation/MuseTalk checkout 0a89dec45a0192b824e3cf4daf96c239440c5ed8
git -C animation/MuseTalk apply ../../patches/musetalk-local.patch
```

如果目录中已经存在这些项目，不要覆盖它们；先核对版本与自己的本地修改。上述命令准备的是第三方代码，模型下载和 Python 环境安装还需按对应上游说明完成。
