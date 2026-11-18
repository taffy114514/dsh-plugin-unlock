# dsh-plugin-unlock（中文文档）

本仓库的完整文档已经**以中文为主**，写在 [README.md](README.md) 里——包括「原理：为什么会出现『这个插件正在使用中』」这一章。

这个文件只是为了让人少点一次：

- **原理讲解** → [README.md#原理为什么会出现这个插件正在使用中](README.md#原理为什么会出现这个插件正在使用中)
- **安装与使用** → [README.md#安装](README.md#安装)
- **配置项** → [README.md#配置](README.md#配置)
- **什么时候帮不上** → [README.md#什么时候它帮不上](README.md#什么时候它帮不上)

一句话版本：DSH 桌面端在卸载/更新插件时，会检查这个包的 loader 条目里还有没有活着的 `fiber`；只要还剩一个就以 `bundle-in-use` 整体拒绝。本插件在管理器检查之前（同一个 tick）把这些 `fiber` 释放掉，然后把动作交还给管理器，让它自己走 pnpm remove → install → reload。

许可：MIT
