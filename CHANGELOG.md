# 更新记录

## 1.0.0

- 首次发布：监听 DSH 的五类任务完成信号（会话轮次、子任务、后台任务、目标、工作流），
  通过系统通知告知用户任务名称与结束原因。
- Windows 采用 WinRT 吐司通知，自动回落到托盘气泡；Linux 依次尝试 notify-send、zenity、kdialog；
  macOS 使用 osascript。也可用 `command` 配置项完全自定义投递程序。
- `locale` 一个字段决定整套文案语言；`title` / `failureTitle` / `bodyTemplate` 留空即跟随语言。
- 暴露 `task-notifier/completed` 事件，供其他插件复用同一完成信号。
