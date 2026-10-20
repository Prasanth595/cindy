//! Read-only adapter for the native configuration-layer loader. In particular,
//! config discovery cannot create a home, write credentials, or execute Hooks.
use codex_file_system::{
    CopyOptions, CreateDirectoryOptions, ExecutorFileSystem, ExecutorFileSystemFuture,
    FileMetadata, FileSystemReadStream, FileSystemSandboxContext, ReadDirectoryEntry, RemoveOptions,
};
use codex_utils_path_uri::PathUri;
use std::io::{self, Read};

pub struct SourceFileSystem;

fn unsupported<'a, T: Send + 'a>() -> ExecutorFileSystemFuture<'a, T> {
    Box::pin(async { Err(io::Error::new(io::ErrorKind::Unsupported, "read-only rule discovery")) })
}

impl ExecutorFileSystem for SourceFileSystem {
    fn canonicalize<'a>(&'a self, path: &'a PathUri, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, PathUri> {
        Box::pin(async move {
            let path = path.to_abs_path()?.canonicalize()?;
            Ok(PathUri::from_abs_path(&path))
        })
    }
    fn read_file<'a>(&'a self, path: &'a PathUri, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, Vec<u8>> {
        Box::pin(async move {
            let path = path.to_abs_path()?;
            let mut bytes = Vec::new();
            std::fs::File::open(path.as_path())?.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "configuration too large"));
            }
            Ok(bytes)
        })
    }
    fn read_file_stream<'a>(&'a self, _: &'a PathUri, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, FileSystemReadStream> { unsupported() }
    fn write_file<'a>(&'a self, _: &'a PathUri, _: Vec<u8>, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, ()> { unsupported() }
    fn create_directory<'a>(&'a self, _: &'a PathUri, _: CreateDirectoryOptions, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, ()> { unsupported() }
    fn get_metadata<'a>(&'a self, path: &'a PathUri, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, FileMetadata> {
        Box::pin(async move {
            let path = path.to_abs_path()?;
            let metadata = tokio::fs::metadata(path.as_path()).await?;
            Ok(FileMetadata {
                is_directory: metadata.is_dir(), is_file: metadata.is_file(),
                is_symlink: tokio::fs::symlink_metadata(path.as_path()).await?.is_symlink(),
                size: metadata.len(), created_at_ms: 0, modified_at_ms: 0,
            })
        })
    }
    fn read_directory<'a>(&'a self, path: &'a PathUri, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>> {
        Box::pin(async move {
            let path = path.to_abs_path()?;
            let mut dir = tokio::fs::read_dir(path.as_path()).await?;
            let mut entries = Vec::new();
            while let Some(entry) = dir.next_entry().await? {
                let kind = entry.file_type().await?;
                entries.push(ReadDirectoryEntry {
                    file_name: entry.file_name().into_string().map_err(|_| io::ErrorKind::InvalidData)?,
                    is_directory: kind.is_dir(), is_file: kind.is_file(),
                });
            }
            Ok(entries)
        })
    }
    fn remove<'a>(&'a self, _: &'a PathUri, _: RemoveOptions, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, ()> { unsupported() }
    fn copy<'a>(&'a self, _: &'a PathUri, _: &'a PathUri, _: CopyOptions, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, ()> { unsupported() }
}
