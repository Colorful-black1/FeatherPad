use serde::{Deserialize, Serialize};
use std::fmt;

pub const HELP: &str = "\
轻羽 FeatherPad

用法:
  featherpad [选项] [--] [文件或目录...]
  featherpad --goto <路径:行[:列]>

选项:
  --reuse-window       在现有窗口打开（默认）
  --new-window         在新窗口打开
  --goto <路径:行[:列]>
                       打开文件并跳转到 1 基行列
  --wait               等待本次打开的文档关闭或明确放弃
  --help, -h           显示帮助
  --                   后续参数全部作为路径，不解析为选项

退出码:
  0  成功
  1  路径、实例通信或文档生命周期失败
  2  参数冲突或格式错误
";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowMode {
    Reuse,
    New,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GotoTarget {
    pub path: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliRun {
    pub window_mode: WindowMode,
    pub wait: bool,
    pub goto: Option<GotoTarget>,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CliAction {
    Help,
    Run(CliRun),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CliError {
    pub message: String,
    pub exit_code: u8,
}

impl CliError {
    fn arguments(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: 2,
        }
    }

    pub fn routing(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: 1,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub fn parse(args: &[String]) -> Result<CliAction, CliError> {
    if args.len() == 1 && matches!(args[0].as_str(), "--help" | "-h") {
        return Ok(CliAction::Help);
    }

    let mut reuse = false;
    let mut create_new = false;
    let mut wait = false;
    let mut goto = None;
    let mut paths = Vec::new();
    let mut path_only = false;
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if !path_only && argument == "--" {
            path_only = true;
            index += 1;
            continue;
        }
        if !path_only && argument == "--reuse-window" {
            reuse = true;
        } else if !path_only && argument == "--new-window" {
            create_new = true;
        } else if !path_only && argument == "--wait" {
            wait = true;
        } else if !path_only && argument == "--goto" {
            if goto.is_some() {
                return Err(CliError::arguments("--goto 只能指定一次。"));
            }
            index += 1;
            let target = args
                .get(index)
                .ok_or_else(|| CliError::arguments("--goto 缺少“路径:行[:列]”。"))?;
            goto = Some(parse_goto(target)?);
        } else if !path_only && argument.starts_with('-') {
            return Err(CliError::arguments(format!("未知选项：{argument}")));
        } else {
            validate_path(argument)?;
            paths.push(argument.clone());
        }
        index += 1;
    }

    if reuse && create_new {
        return Err(CliError::arguments(
            "--reuse-window 与 --new-window 不能同时使用。",
        ));
    }
    if goto.is_some() && !paths.is_empty() {
        return Err(CliError::arguments("--goto 目标不能与其他位置参数混用。"));
    }
    if wait && goto.is_none() && paths.is_empty() {
        return Err(CliError::arguments("--wait 需要至少一个文件或目录。"));
    }

    Ok(CliAction::Run(CliRun {
        window_mode: if create_new {
            WindowMode::New
        } else {
            WindowMode::Reuse
        },
        wait,
        goto,
        paths,
    }))
}

fn parse_goto(value: &str) -> Result<GotoTarget, CliError> {
    if value.is_empty() || value.len() > 32_767 {
        return Err(CliError::arguments("--goto 目标为空或过长。"));
    }
    let (without_column, last) = value
        .rsplit_once(':')
        .ok_or_else(|| CliError::arguments("--goto 必须包含行号。"))?;
    if last.is_empty() || !last.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CliError::arguments("--goto 行列必须为正整数。"));
    }
    let last_number = last
        .parse::<u32>()
        .map_err(|_| CliError::arguments("--goto 行列超出范围。"))?;
    let (path, line, column) = match without_column.rsplit_once(':') {
        Some((path, before_last))
            if !before_last.is_empty() && before_last.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            (
                path,
                before_last
                    .parse::<u32>()
                    .map_err(|_| CliError::arguments("--goto 行号超出范围。"))?,
                last_number,
            )
        }
        _ => (without_column, last_number, 1),
    };
    if path.is_empty() {
        return Err(CliError::arguments("--goto 缺少文件路径。"));
    }
    if line == 0 || column == 0 {
        return Err(CliError::arguments("--goto 行号和列号从 1 开始。"));
    }
    validate_path(path)?;
    Ok(GotoTarget {
        path: path.to_owned(),
        line,
        column,
    })
}

fn validate_path(path: &str) -> Result<(), CliError> {
    if path.is_empty() {
        return Err(CliError::arguments("路径不能为空。"));
    }
    if path.len() > 32_767 || path.contains('\0') {
        return Err(CliError::arguments("路径过长或包含 NUL。"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parses_drive_colon_goto_and_default_column() {
        let action = parse(&strings(&[
            "--reuse-window",
            "--goto",
            r"D:\笔记\一:12:5",
            "--wait",
        ]))
        .unwrap();
        assert_eq!(
            action,
            CliAction::Run(CliRun {
                window_mode: WindowMode::Reuse,
                wait: true,
                goto: Some(GotoTarget {
                    path: r"D:\笔记\一".into(),
                    line: 12,
                    column: 5,
                }),
                paths: Vec::new(),
            })
        );
        let action = parse(&strings(&["--goto", r"C:\a.md:3"])).unwrap();
        let CliAction::Run(run) = action else {
            panic!("expected run");
        };
        assert_eq!(run.goto.unwrap().column, 1);
    }

    #[test]
    fn double_dash_preserves_dash_prefixed_paths() {
        let action = parse(&strings(&["--", "--name.txt", "-folder"])).unwrap();
        let CliAction::Run(run) = action else {
            panic!("expected run");
        };
        assert_eq!(run.paths, strings(&["--name.txt", "-folder"]));
    }

    #[test]
    fn rejects_conflicting_window_modes_and_unknown_options() {
        assert_eq!(
            parse(&strings(&["--reuse-window", "--new-window", "a.txt"]))
                .unwrap_err()
                .exit_code,
            2
        );
        assert_eq!(
            parse(&strings(&["--unknown", "a.txt"]))
                .unwrap_err()
                .exit_code,
            2
        );
    }

    #[test]
    fn rejects_zero_or_non_numeric_locations() {
        for invalid in [r"C:\a.txt:0", r"C:\a.txt:2:0", r"C:\a.txt:last"] {
            assert_eq!(
                parse(&strings(&["--goto", invalid])).unwrap_err().exit_code,
                2
            );
        }
    }

    #[test]
    fn help_is_explicit_and_offline() {
        assert_eq!(parse(&strings(&["--help"])).unwrap(), CliAction::Help);
        assert!(HELP.contains("--wait"));
        assert!(HELP.contains("退出码"));
    }
}
