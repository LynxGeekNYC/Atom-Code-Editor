# Remote Code Editor Package for Atom 

## atom-vsftp

An Atom package that lets you work with VSFTP / FTP(S) servers as if they were local:

- Save / upload files directly to remote servers
- Browse remote directories in a side panel
- Edit remote files via temporary local copies (auto re-upload on save)
- Drag and drop files or folders into the panel to upload
- Create, rename, delete remote files and folders
- Change permissions (chmod) on any file or directory
- Download entire remote directories as ZIP archives
- Support for multiple servers and local ↔ remote path mappings

### Features

- **Multiple servers**
  - Define servers in Atom settings as JSON
  - Quick server picker buttons in a side panel

- **Remote browser panel**
  - List directories with `client.list()`
  - Navigate into folders, go up to parent, refresh
  - Context menu on right click (open, chmod, rename, delete, download dir as zip)

- **Live editing**
  - Auto-upload on save for local project files (with optional path mappings)
  - Open remote files into Atom as temp files and sync back on save

- **File operations**
  - New file / new folder in current remote directory
  - Rename and delete files or directories
  - Change permissions using `SITE CHMOD` (if supported by server)

- **Drag & drop uploads**
  - Drag files or folders onto the remote panel
  - Folders are uploaded recursively, preserving structure

- **Download directory as ZIP**
  - Recursively download a remote directory
  - Package it into a ZIP in your temp folder

### Commands

- `atom-vsftp:connect` – connect to default or selected server  
- `atom-vsftp:disconnect` – disconnect from current server  
- `atom-vsftp:toggle-server-panel` – show / hide the server + remote browser panel  
- `atom-vsftp:upload-current-file` – upload the active editor file  
- `atom-vsftp:download-remote-file` – open selected remote file in Atom  
- `atom-vsftp:chmod-selected` – change permissions on selected remote entry  
- `atom-vsftp:rename-selected` – rename selected file or directory  
- `atom-vsftp:delete-selected` – delete selected file or directory  
- `atom-vsftp:download-dir-as-zip` – download selected directory as a ZIP

### Configuration

All configuration is done via Atom’s package settings:

- **Servers** – JSON array of server definitions  
- **Default server name** – which server to use for `connect`  
- **Auto upload on save** – toggle automatic uploads for local files  
- **Path mappings** – optional local → remote base path mappings per server  

Example `Servers` JSON:

```json
[
  {
    "name": "My VSFTP Server",
    "host": "example.com",
    "port": 21,
    "user": "username",
    "password": "password",
    "secure": false,
    "remoteBasePath": "/var/www/html"
  }
]

