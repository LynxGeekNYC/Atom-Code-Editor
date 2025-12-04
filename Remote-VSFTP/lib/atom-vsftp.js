'use babel';

const { CompositeDisposable } = require('atom');
const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');

module.exports = {
  subscriptions: null,
  client: null,
  connectedServer: null,
  editorSaveSubscriptions: null,

  remotePanel: null,
  remotePanelElement: null,
  serverListElement: null,
  remotePathLabelElement: null,
  remoteListElement: null,

  remoteBrowserState: {
    currentDir: '/',
    items: [],
    selectedIndex: -1
  },

  // localTempPath => remotePath
  remoteOpenFiles: null,

  config: {
    servers: {
      title: 'Servers',
      description:
        'JSON array of server definitions. Example below. ' +
        'Note: password is stored in plain text. Do not use for highly sensitive accounts.',
      type: 'string',
      default: JSON.stringify(
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
        ],
        null,
        2
      )
    },
    defaultServerName: {
      title: 'Default server name',
      description:
        'Name field of the server entry to use for connect command.',
      type: 'string',
      default: 'My VSFTP Server'
    },
    autoUploadOnSave: {
      title: 'Auto upload on save (local project files)',
      description:
        'If enabled, every file you save inside a project will be uploaded to the connected server using mappings or remoteBasePath.',
      type: 'boolean',
      default: true
    },
    showNotifications: {
      title: 'Show notifications',
      description: 'Show Atom notifications for connection and upload status.',
      type: 'boolean',
      default: true
    },
    pathMappings: {
      title: 'Local → Remote path mappings',
      description:
        'JSON array of mappings when local and remote paths differ. ' +
        'Each item: { "serverName": "My VSFTP Server", "localBasePath": "/Users/you/projects/site", "remoteBasePath": "/var/www/html" }',
      type: 'string',
      default: JSON.stringify(
        [
          {
            "serverName": "My VSFTP Server",
            "localBasePath": "/path/to/local/site",
            "remoteBasePath": "/var/www/html"
          }
        ],
        null,
        2
      )
    }
  },

  activate() {
    this.subscriptions = new CompositeDisposable();
    this.editorSaveSubscriptions = new CompositeDisposable();
    this.remoteOpenFiles = new Map();

    // Commands
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'atom-vsftp:connect': () => this.connect(),
        'atom-vsftp:disconnect': () => this.disconnect(),
        'atom-vsftp:upload-current-file': () => this.uploadCurrentFile(),
        'atom-vsftp:toggle-server-panel': () => this.toggleRemotePanel(),
        'atom-vsftp:download-remote-file': () => this.downloadSelectedRemoteFile(),
        'atom-vsftp:chmod-selected': () => this.chmodSelected(),
        'atom-vsftp:delete-selected': () => this.deleteSelected(),
        'atom-vsftp:rename-selected': () => this.renameSelected(),
        'atom-vsftp:download-dir-as-zip': () => this.downloadSelectedDirectoryAsZip()
      })
    );

    // Context menu for remote items
    atom.contextMenu.add({
      '.atom-vsftp-remote-item': [
        {
          label: 'Open remote file',
          command: 'atom-vsftp:download-remote-file'
        },
        {
          label: 'Change permissions (chmod)',
          command: 'atom-vsftp:chmod-selected'
        },
        {
          type: 'separator'
        },
        {
          label: 'Download directory as zip',
          command: 'atom-vsftp:download-dir-as-zip'
        },
        {
          type: 'separator'
        },
        {
          label: 'Rename',
          command: 'atom-vsftp:rename-selected'
        },
        {
          label: 'Delete',
          command: 'atom-vsftp:delete-selected'
        }
      ]
    });

    if (atom.config.get('atom-vsftp.autoUploadOnSave')) {
      this.subscribeToEditorSaves();
    }

    this.subscriptions.add(
      atom.config.onDidChange('atom-vsftp.autoUploadOnSave', ({ newValue }) => {
        if (newValue) {
          this.subscribeToEditorSaves();
        } else {
          this.editorSaveSubscriptions.dispose();
          this.editorSaveSubscriptions = new CompositeDisposable();
        }
      })
    );

    this.subscriptions.add(
      atom.config.onDidChange('atom-vsftp.servers', () => {
        this.renderServerList();
      })
    );

    this.createRemotePanel();
  },

  deactivate() {
    this.disconnect();
    if (this.subscriptions) {
      this.subscriptions.dispose();
    }
    if (this.editorSaveSubscriptions) {
      this.editorSaveSubscriptions.dispose();
    }
    if (this.remotePanel) {
      this.remotePanel.destroy();
    }
    this.remoteOpenFiles = null;
  },

  serialize() {
    return {};
  },

  // ---------------------------
  // Config helpers
  // ---------------------------

  getServersFromConfig() {
    const raw = atom.config.get('atom-vsftp.servers');
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        return list;
      }
      throw new Error('Servers config must be an array');
    } catch (err) {
      this.notify('Error parsing atom-vsftp servers config. Check JSON syntax.', 'error');
      console.error('[atom-vsftp] Error parsing servers config:', err);
      return [];
    }
  },

  findServerByName(name) {
    const servers = this.getServersFromConfig();
    return servers.find(s => s.name === name);
  },

  findDefaultServer() {
    const name = atom.config.get('atom-vsftp.defaultServerName');
    return this.findServerByName(name);
  },

  getPathMappingsFromConfig() {
    const raw = atom.config.get('atom-vsftp.pathMappings');
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        return list;
      }
      throw new Error('Mappings config must be an array');
    } catch (err) {
      this.notify('Error parsing atom-vsftp pathMappings config. Check JSON syntax.', 'error');
      console.error('[atom-vsftp] Error parsing pathMappings config:', err);
      return [];
    }
  },

  // ---------------------------
  // Connection
  // ---------------------------

  async connect(serverName) {
    if (this.client) {
      this.disconnect();
    }

    const server = serverName
      ? this.findServerByName(serverName)
      : this.findDefaultServer();

    if (!server) {
      this.notify('Server not found. Check atom-vsftp settings.', 'error');
      return;
    }

    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
      await client.access({
        host: server.host,
        port: server.port || 21,
        user: server.user,
        password: server.password,
        secure: !!server.secure
      });

      this.client = client;
      this.connectedServer = server;

      // Reset remote browser state
      this.remoteBrowserState.currentDir = server.remoteBasePath || '/';
      this.remoteBrowserState.items = [];
      this.remoteBrowserState.selectedIndex = -1;
      await this.refreshRemoteList();

      this.notify(`Connected to ${server.name}`, 'success');
    } catch (err) {
      client.close();
      this.notify('Could not connect to VSFTP server. See console for details.', 'error');
      console.error('[atom-vsftp] Connection error:', err);
    }
  },

  disconnect() {
    if (this.client) {
      this.client.close();
      this.client = null;
      this.connectedServer = null;
      this.remoteBrowserState.items = [];
      this.remoteBrowserState.selectedIndex = -1;
      this.notify('Disconnected from VSFTP server.', 'info');
      this.renderRemoteList();
      this.updateRemotePathLabel();
    }
  },

  // ---------------------------
  // Editor save / uploads
  // ---------------------------

  async uploadCurrentFile() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      this.notify('No active editor to upload.', 'info');
      return;
    }
    const filePath = editor.getPath();
    if (!filePath) {
      this.notify('File must be saved locally before it can be uploaded.', 'warning');
      return;
    }

    await this.uploadFile(filePath);
  },

  subscribeToEditorSaves() {
    this.editorSaveSubscriptions.dispose();
    this.editorSaveSubscriptions = new CompositeDisposable();

    this.editorSaveSubscriptions.add(
      atom.workspace.observeTextEditors(editor => {
        this.editorSaveSubscriptions.add(
          editor.onDidSave(event => {
            const filePath = event.path;
            if (filePath) {
              this.uploadFile(filePath);
            }
          })
        );
      })
    );
  },

  // Compute remote path for a local file, using mappings if available
  getRemotePathForLocalFile(localPath) {
    if (!this.connectedServer) {
      return null;
    }

    // 1. Check explicit mappings
    const mappings = this.getPathMappingsFromConfig();
    let bestMapping = null;
    for (const m of mappings) {
      if (!m || !m.serverName || !m.localBasePath) continue;
      if (m.serverName !== this.connectedServer.name) continue;

      const localBase = m.localBasePath.replace(/\\/g, '/');
      const normalizedLocal = localPath.replace(/\\/g, '/');
      if (normalizedLocal.startsWith(localBase)) {
        if (!bestMapping || localBase.length > bestMapping.localBasePath.length) {
          bestMapping = m;
        }
      }
    }

    if (bestMapping) {
      const localBase = bestMapping.localBasePath.replace(/\\/g, '/');
      let rel = localPath.replace(/\\/g, '/').slice(localBase.length);
      if (rel.startsWith('/')) rel = rel.slice(1);
      const remoteBase = (bestMapping.remoteBasePath || '/').replace(/\\/g, '/');
      const remoteRel = rel.split('/').join('/');
      let fullRemote = remoteBase;
      if (!fullRemote.endsWith('/')) {
        fullRemote += '/';
      }
      fullRemote += remoteRel;
      return fullRemote;
    }

    // 2. Fallback: use server.remoteBasePath + project-relative path
    const remoteBase = (this.connectedServer.remoteBasePath || '/').replace(/\\/g, '/');
    const [projectPath, relative] = atom.project.relativizePath(localPath);

    let rel = relative;
    if (!projectPath || !relative) {
      rel = path.basename(localPath);
    }

    const remoteRelative = rel.split(path.sep).join('/');
    let fullRemote = remoteBase;
    if (!fullRemote.endsWith('/')) {
      fullRemote += '/';
    }
    fullRemote += remoteRelative;

    return fullRemote;
  },

  async uploadFile(localPath, remotePathOverride) {
    if (!this.client || !this.connectedServer) {
      this.notify('Not connected to any VSFTP server. Run atom-vsftp:connect first.', 'warning');
      return;
    }

    let remotePath = remotePathOverride;

    // If this is a temp file associated with remote, use that mapping
    if (!remotePath && this.remoteOpenFiles && this.remoteOpenFiles.has(localPath)) {
      remotePath = this.remoteOpenFiles.get(localPath);
    }

    if (!remotePath) {
      remotePath = this.getRemotePathForLocalFile(localPath);
    }

    if (!remotePath) {
      this.notify('Could not determine remote path for file.', 'error');
      return;
    }

    try {
      const remoteDir = remotePath.split('/').slice(0, -1).join('/') || '/';

      await this.client.ensureDir(remoteDir);
      await this.client.uploadFrom(localPath, remotePath);

      this.notify(`Uploaded to ${remotePath}`, 'success');
    } catch (err) {
      this.notify('Upload failed. See console for details.', 'error');
      console.error('[atom-vsftp] Upload error:', err);
    }
  },

  // ---------------------------
  // Remote panel and browser UI
  // ---------------------------

  createRemotePanel() {
    if (this.remotePanelElement) return;

    const container = document.createElement('div');
    container.classList.add('atom-vsftp-panel');
    container.style.padding = '8px';
    container.style.fontSize = '12px';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.height = '100%';

    const title = document.createElement('div');
    title.textContent = 'VSFTP Servers / Remote Browser';
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '6px';
    container.appendChild(title);

    // Server list
    const serverHeader = document.createElement('div');
    serverHeader.textContent = 'Servers:';
    serverHeader.style.marginTop = '4px';
    container.appendChild(serverHeader);

    const serverList = document.createElement('div');
    serverList.style.display = 'flex';
    serverList.style.flexWrap = 'wrap';
    serverList.style.gap = '4px';
    serverList.style.marginBottom = '6px';
    container.appendChild(serverList);
    this.serverListElement = serverList;

    // Remote path and controls
    const pathRow = document.createElement('div');
    pathRow.style.display = 'flex';
    pathRow.style.alignItems = 'center';
    pathRow.style.justifyContent = 'space-between';
    pathRow.style.marginBottom = '4px';

    const pathLabel = document.createElement('div');
    pathLabel.textContent = 'Path: /';
    pathLabel.style.flex = '1';
    pathLabel.style.overflow = 'hidden';
    pathLabel.style.textOverflow = 'ellipsis';
    pathLabel.style.whiteSpace = 'nowrap';
    this.remotePathLabelElement = pathLabel;
    pathRow.appendChild(pathLabel);

    const btnParent = document.createElement('button');
    btnParent.classList.add('btn', 'btn-xs');
    btnParent.textContent = 'Up';
    btnParent.addEventListener('click', () => this.goToParentDir());
    pathRow.appendChild(btnParent);

    const btnRefresh = document.createElement('button');
    btnRefresh.classList.add('btn', 'btn-xs');
    btnRefresh.textContent = 'Refresh';
    btnRefresh.style.marginLeft = '4px';
    btnRefresh.addEventListener('click', () => this.refreshRemoteList());
    pathRow.appendChild(btnRefresh);

    container.appendChild(pathRow);

    // File list
    const listContainer = document.createElement('div');
    listContainer.style.flex = '1';
    listContainer.style.overflow = 'auto';
    listContainer.style.border = '1px solid #444';
    listContainer.style.padding = '4px';
    this.remoteListElement = listContainer;
    container.appendChild(listContainer);

    // Drag and drop upload
    listContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    listContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      const dt = e.dataTransfer;
      if (!dt || !dt.files || dt.files.length === 0) {
        return;
      }
      const files = Array.from(dt.files);
      this.handleDropUpload(files).catch(err => {
        console.error('[atom-vsftp] drag and drop upload error:', err);
        this.notify('Drag and drop upload failed. See console for details.', 'error');
      });
    });

    // Action buttons
    const actionRow = document.createElement('div');
    actionRow.style.display = 'flex';
    actionRow.style.flexWrap = 'wrap';
    actionRow.style.gap = '4px';
    actionRow.style.marginTop = '6px';

    const btnOpen = document.createElement('button');
    btnOpen.classList.add('btn', 'btn-xs');
    btnOpen.textContent = 'Open file';
    btnOpen.addEventListener('click', () => this.downloadSelectedRemoteFile());
    actionRow.appendChild(btnOpen);

    const btnChmod = document.createElement('button');
    btnChmod.classList.add('btn', 'btn-xs');
    btnChmod.textContent = 'chmod';
    btnChmod.addEventListener('click', () => this.chmodSelected());
    actionRow.appendChild(btnChmod);

    const btnNewFile = document.createElement('button');
    btnNewFile.classList.add('btn', 'btn-xs');
    btnNewFile.textContent = 'New file';
    btnNewFile.addEventListener('click', () => this.newRemoteFile());
    actionRow.appendChild(btnNewFile);

    const btnNewFolder = document.createElement('button');
    btnNewFolder.classList.add('btn', 'btn-xs');
    btnNewFolder.textContent = 'New folder';
    btnNewFolder.addEventListener('click', () => this.newRemoteFolder());
    actionRow.appendChild(btnNewFolder);

    const btnRename = document.createElement('button');
    btnRename.classList.add('btn', 'btn-xs');
    btnRename.textContent = 'Rename';
    btnRename.addEventListener('click', () => this.renameSelected());
    actionRow.appendChild(btnRename);

    const btnDelete = document.createElement('button');
    btnDelete.classList.add('btn', 'btn-xs');
    btnDelete.textContent = 'Delete';
    btnDelete.addEventListener('click', () => this.deleteSelected());
    actionRow.appendChild(btnDelete);

    const btnZipDir = document.createElement('button');
    btnZipDir.classList.add('btn', 'btn-xs');
    btnZipDir.textContent = 'Dir as zip';
    btnZipDir.addEventListener('click', () => this.downloadSelectedDirectoryAsZip());
    actionRow.appendChild(btnZipDir);

    container.appendChild(actionRow);

    this.remotePanelElement = container;
    this.remotePanel = atom.workspace.addRightPanel({
      item: container,
      visible: false
    });

    this.renderServerList();
    this.renderRemoteList();
    this.updateRemotePathLabel();
  },

  toggleRemotePanel() {
    if (!this.remotePanel) {
      this.createRemotePanel();
    }
    if (this.remotePanel.isVisible()) {
      this.remotePanel.hide();
    } else {
      this.remotePanel.show();
    }
  },

  renderServerList() {
    if (!this.serverListElement) return;
    const servers = this.getServersFromConfig();

    this.serverListElement.innerHTML = '';

    if (!servers.length) {
      const msg = document.createElement('div');
      msg.textContent = 'No servers configured';
      this.serverListElement.appendChild(msg);
      return;
    }

    servers.forEach(server => {
      const btn = document.createElement('button');
      btn.classList.add('btn', 'btn-xs');
      btn.textContent = server.name || server.host;
      btn.addEventListener('click', () => this.connect(server.name));
      this.serverListElement.appendChild(btn);
    });
  },

  updateRemotePathLabel() {
    if (!this.remotePathLabelElement) return;
    if (!this.connectedServer || !this.client) {
      this.remotePathLabelElement.textContent = 'Path: (not connected)';
      return;
    }
    this.remotePathLabelElement.textContent = `Path: ${this.remoteBrowserState.currentDir}`;
  },

  renderRemoteList() {
    if (!this.remoteListElement) return;

    this.remoteListElement.innerHTML = '';

    if (!this.connectedServer || !this.client) {
      const msg = document.createElement('div');
      msg.textContent = 'Not connected.';
      this.remoteListElement.appendChild(msg);
      return;
    }

    if (!this.remoteBrowserState.items.length) {
      const msg = document.createElement('div');
      msg.textContent = 'No entries or not loaded yet.';
      this.remoteListElement.appendChild(msg);
      return;
    }

    this.remoteBrowserState.items.forEach((item, index) => {
      const row = document.createElement('div');
      row.classList.add('atom-vsftp-remote-item');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.cursor = 'pointer';
      row.style.padding = '2px 0';

      if (this.remoteBrowserState.selectedIndex === index) {
        row.style.backgroundColor = '#333';
      }

      row.addEventListener('click', () => {
        this.remoteBrowserState.selectedIndex = index;
        this.renderRemoteList();
      });

      row.addEventListener('dblclick', () => {
        if (item.type === ftp.FileType.Directory) {
          this.enterDirectory(item.name);
        } else {
          this.downloadRemoteFileByItem(item);
        }
      });

      // Right click selects item so context menu commands work on that row
      row.addEventListener('contextmenu', () => {
        this.remoteBrowserState.selectedIndex = index;
        this.renderRemoteList();
      });

      const left = document.createElement('div');
      left.style.flex = '1';
      left.style.overflow = 'hidden';
      left.style.textOverflow = 'ellipsis';
      left.style.whiteSpace = 'nowrap';

      const typePrefix = item.type === ftp.FileType.Directory ? '[DIR] ' : '[FILE] ';
      left.textContent = `${typePrefix}${item.name}`;
      row.appendChild(left);

      const right = document.createElement('div');
      right.style.textAlign = 'right';
      right.style.minWidth = '60px';
      right.textContent = item.size != null ? String(item.size) : '';
      row.appendChild(right);

      this.remoteListElement.appendChild(row);
    });
  },

  async refreshRemoteList() {
    if (!this.client || !this.connectedServer) {
      this.renderRemoteList();
      this.updateRemotePathLabel();
      return;
    }

    try {
      const dir = this.remoteBrowserState.currentDir || this.connectedServer.remoteBasePath || '/';
      const list = await this.client.list(dir);

      this.remoteBrowserState.currentDir = dir;
      this.remoteBrowserState.items = list;
      this.remoteBrowserState.selectedIndex = -1;

      this.updateRemotePathLabel();
      this.renderRemoteList();
    } catch (err) {
      this.notify('Error listing remote directory. See console for details.', 'error');
      console.error('[atom-vsftp] list error:', err);
    }
  },

  joinRemotePath(dir, name) {
    if (!dir || dir === '/') {
      return '/' + name;
    }
    return (dir.endsWith('/') ? dir : dir + '/') + name;
  },

  goToParentDir() {
    if (!this.connectedServer) return;
    const current = this.remoteBrowserState.currentDir || '/';
    const parts = current.split('/').filter(Boolean);
    if (parts.length === 0) {
      this.remoteBrowserState.currentDir = '/';
    } else {
      parts.pop();
      this.remoteBrowserState.currentDir = '/' + parts.join('/');
    }
    this.refreshRemoteList();
  },

  enterDirectory(name) {
    const newDir = this.joinRemotePath(this.remoteBrowserState.currentDir, name);
    this.remoteBrowserState.currentDir = newDir;
    this.refreshRemoteList();
  },

  // ---------------------------
  // Remote download and editing
  // ---------------------------

  getSelectedRemoteItem() {
    const idx = this.remoteBrowserState.selectedIndex;
    if (idx == null || idx < 0) return null;
    return this.remoteBrowserState.items[idx] || null;
  },

  async downloadSelectedRemoteFile() {
    const item = this.getSelectedRemoteItem();
    if (!item) {
      this.notify('No remote item selected.', 'warning');
      return;
    }
    if (item.type === ftp.FileType.Directory) {
      this.notify('Selected item is a directory. Use "Dir as zip" to download directories.', 'info');
      return;
    }
    await this.downloadRemoteFileByItem(item);
  },

  async downloadRemoteFileByItem(item) {
    if (!this.client || !this.connectedServer) {
      this.notify('Not connected to any VSFTP server.', 'warning');
      return;
    }

    const remotePath = this.joinRemotePath(this.remoteBrowserState.currentDir, item.name);

    try {
      const baseTmpDir = path.join(os.tmpdir(), 'atom-vsftp');
      if (!fs.existsSync(baseTmpDir)) {
        fs.mkdirSync(baseTmpDir, { recursive: true });
      }

      const safeServerName = (this.connectedServer.name || this.connectedServer.host || 'server')
        .replace(/[^a-zA-Z0-9_\-]/g, '_');

      const serverTmpDir = path.join(baseTmpDir, safeServerName);
      if (!fs.existsSync(serverTmpDir)) {
        fs.mkdirSync(serverTmpDir, { recursive: true });
      }

      const remoteRelative = remotePath.replace(/^\/+/, '');
      const localTmpPath = path.join(serverTmpDir, remoteRelative.split('/').join(path.sep));
      const localTmpDir = path.dirname(localTmpPath);
      if (!fs.existsSync(localTmpDir)) {
        fs.mkdirSync(localTmpDir, { recursive: true });
      }

      await this.client.downloadTo(localTmpPath, remotePath);

      const editor = await atom.workspace.open(localTmpPath);
      this.remoteOpenFiles.set(localTmpPath, remotePath);

      const disp = editor.onDidDestroy(() => {
        this.remoteOpenFiles.delete(localTmpPath);
        disp.dispose();
      });

      this.notify(`Downloaded ${remotePath} to temp and opened in Atom. Save to upload changes.`, 'success');
    } catch (err) {
      this.notify('Download failed. See console for details.', 'error');
      console.error('[atom-vsftp] download error:', err);
    }
  },

  // ---------------------------
  // Drag and drop upload
  // ---------------------------

  async handleDropUpload(files) {
    if (!this.client || !this.connectedServer) {
      this.notify('Not connected to any VSFTP server.', 'warning');
      return;
    }

    const currentDir = this.remoteBrowserState.currentDir || '/';

    for (const file of files) {
      const localPath = file.path;
      if (!localPath) continue;

      try {
        const stat = fs.statSync(localPath);
        if (stat.isDirectory()) {
          const remoteDir = this.joinRemotePath(currentDir, path.basename(localPath));
          await this.uploadLocalDirectory(localPath, remoteDir);
          this.notify(`Uploaded folder ${localPath} to ${remoteDir}`, 'success');
        } else if (stat.isFile()) {
          const remotePath = this.joinRemotePath(currentDir, path.basename(localPath));
          await this.uploadFile(localPath, remotePath);
        }
      } catch (err) {
        console.error('[atom-vsftp] handleDropUpload item error:', err);
        this.notify(`Failed to upload ${localPath}. See console for details.`, 'error');
      }
    }

    await this.refreshRemoteList();
  },

  async uploadLocalDirectory(localDir, remoteDir) {
    if (!this.client) return;

    await this.client.ensureDir(remoteDir);

    const entries = fs.readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name);
      const remotePath = this.joinRemotePath(remoteDir, entry.name);

      if (entry.isDirectory()) {
        await this.uploadLocalDirectory(localPath, remotePath);
      } else if (entry.isFile()) {
        const parentRemoteDir = remoteDir;
        await this.client.ensureDir(parentRemoteDir);
        await this.client.uploadFrom(localPath, remotePath);
      }
    }
  },

  // ---------------------------
  // New file and folder
  // ---------------------------

  async newRemoteFile() {
    if (!this.client || !this.connectedServer) {
      this.notify('Not connected to any VSFTP server.', 'warning');
      return;
    }

    const name = window.prompt('Enter new file name', 'newfile.txt');
    if (!name) return;

    const remotePath = this.joinRemotePath(this.remoteBrowserState.currentDir, name);

    try {
      const remoteDir = remotePath.split('/').slice(0, -1).join('/') || '/';
      await this.client.ensureDir(remoteDir);

      const tmpDir = path.join(os.tmpdir(), 'atom-vsftp-newfiles');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      const localTmpPath = path.join(tmpDir, `empty-${Date.now()}.tmp`);
      fs.writeFileSync(localTmpPath, '');

      await this.client.uploadFrom(localTmpPath, remotePath);

      this.notify(`Created new file ${remotePath}`, 'success');
      await this.refreshRemoteList();
    } catch (err) {
      this.notify('Failed to create new file. See console for details.', 'error');
      console.error('[atom-vsftp] newRemoteFile error:', err);
    }
  },

  async newRemoteFolder() {
    if (!this.client || !this.connectedServer) {
      this.notify('Not connected to any VSFTP server.', 'warning');
      return;
    }

    const name = window.prompt('Enter new folder name', 'newfolder');
    if (!name) return;

    const remotePath = this.joinRemotePath(this.remoteBrowserState.currentDir, name);

    try {
      await this.client.ensureDir(remotePath);
      this.notify(`Created new folder ${remotePath}`, 'success');
      await this.refreshRemoteList();
    } catch (err) {
      this.notify('Failed to create new folder. See console for details.', 'error');
      console.error('[atom-vsftp] newRemoteFolder error:', err);
    }
  },

  // ---------------------------
  // Rename and delete
  // ---------------------------

  async renameSelected() {
    if (!this.client || !this.connectedServer) {
      this.notify('Not connected to any VSFTP server.', 'warning');
      return;
    }

    const item = this.getSelectedRemoteItem();
    if (!item) {
      this.notify('No remote item selected.', 'warning');
      return;
    }

    const oldPath = this.joinRemotePath(this.remoteBrowserState.currentDir, item.name);
    const newName = window.prompt('Enter new name', item.name);
    if (!newName || newName === item.name) {
      return;
    }

    const newPath = this.joinRemotePath(this.remoteBrowserState.currentDir, newName);

    try {
      await this.client.rename(oldPath, newPath);
      this.notify(`Renamed ${oldPath} to ${newPath}`, 'success');
      await this.refreshRemoteList();
    } catch (err) {
      this.notify('Rename failed. See console for details.', 'error');
      console.error('[atom-vsftp] rename error:', err);
    }
  },

  async deleteSelected() {
    if (!this.client || !this.connectedServer) {
      this.notify('Not connected to any VSFTP server.', 'warning');
      return;
    }

    const item = this.getSelectedRemoteItem();
    if (!item) {
      this.notify('No remote item selected.', 'warning');
      return;
    }

    const remotePath = this.joinRemotePath(this.remoteBrowserState.currentDir, item.name);

    const ok = window.confirm(
      `Really delete ${remotePath}? This cannot be undone.`
    );
    if (!ok) return;

    try {
      if (item.type === ftp.FileType.Directory) {
        await this.client.removeDir(remotePath);
      } else {
        await this.client.remove(remotePath);
      }

      this.notify(`Deleted ${remotePath}`, 'success');
      await this.refreshRemoteList();
    } catch (err) {
      this.notify('Delete failed. See console for details.', 'error');
      console.error('[atom-vsftp] delete error:', err);
    }
  },

  // ---------------------------
  // Download directory as zip
  // ---------------------------

  async downloadSelectedDirectoryAsZip() {
    const item = this.getSelectedRemoteItem();
    if (!item) {
      this.notify('No remote item selected.', 'warning');
      return;
    }
    if (item.type !== ftp.FileType.Directory) {
      this.notify('Selected item is not a directory.', 'warning');
      return;
    }

    await this.downloadDirectoryAsZip(item);
  },

  async downloadDirectoryAsZip(item) {
    if (!this.client || !this.connectedServer) {
      this.notify('Not connected to any VSFTP server.', 'warning');
      return;
    }

    const remoteDir = this.joinRemotePath(this.remoteBrowserState.currentDir, item.name);

    try {
      const baseTmpDir = path.join(os.tmpdir(), 'atom-vsftp-dir-downloads');
      if (!fs.existsSync(baseTmpDir)) {
        fs.mkdirSync(baseTmpDir, { recursive: true });
      }

      const safeServerName = (this.connectedServer.name || this.connectedServer.host || 'server')
        .replace(/[^a-zA-Z0-9_\-]/g, '_');

      const serverTmpDir = path.join(baseTmpDir, safeServerName);
      if (!fs.existsSync(serverTmpDir)) {
        fs.mkdirSync(serverTmpDir, { recursive: true });
      }

      const localDirRoot = path.join(serverTmpDir, remoteDir.replace(/^\/+/, '').split('/').join(path.sep));
      await this.downloadDirRecursive(remoteDir, localDirRoot);

      const zip = new AdmZip();
      zip.addLocalFolder(localDirRoot, item.name);

      const zipFileName = `${item.name}-${Date.now()}.zip`;
      const zipPath = path.join(serverTmpDir, zipFileName);
      zip.writeZip(zipPath);

      this.notify(`Directory downloaded and zipped to: ${zipPath}`, 'success');
    } catch (err) {
      this.notify('Failed to download directory as zip. See console for details.', 'error');
      console.error('[atom-vsftp] downloadDirectoryAsZip error:', err);
    }
  },

  async downloadDirRecursive(remoteDir, localDir) {
    if (!this.client) return;

    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    const list = await this.client.list(remoteDir);
    for (const entry of list) {
      const remotePath = this.joinRemotePath(remoteDir, entry.name);
      const localPath = path.join(localDir, entry.name);

      if (entry.type === ftp.FileType.Directory) {
        await this.downloadDirRecursive(remotePath, localPath);
      } else {
        const parentDir = path.dirname(localPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        await this.client.downloadTo(localPath, remotePath);
      }
    }
  },

  // ---------------------------
  // chmod support
  // ---------------------------

  async chmodSelected() {
    if (!this.client || !this.connectedServer) {
      this.notify('Not connected to any VSFTP server.', 'warning');
      return;
    }
    const item = this.getSelectedRemoteItem();
    if (!item) {
      this.notify('No remote item selected.', 'warning');
      return;
    }

    const remotePath = this.joinRemotePath(this.remoteBrowserState.currentDir, item.name);

    const mode = window.prompt(
      `Enter chmod mode (for example 644, 755) for ${remotePath}`,
      '644'
    );
    if (!mode) {
      return;
    }

    try {
      await this.client.send(`SITE CHMOD ${mode} ${remotePath}`);
      this.notify(`chmod ${mode} applied to ${remotePath}`, 'success');
    } catch (err) {
      this.notify('chmod failed. Your FTP server may not support SITE CHMOD. See console.', 'error');
      console.error('[atom-vsftp] chmod error:', err);
    }
  },

  // ---------------------------
  // Notifications
  // ---------------------------

  notify(message, type) {
    if (!atom.config.get('atom-vsftp.showNotifications')) {
      return;
    }
    switch (type) {
      case 'success':
        atom.notifications.addSuccess(message);
        break;
      case 'warning':
        atom.notifications.addWarning(message);
        break;
      case 'error':
        atom.notifications.addError(message);
        break;
      default:
        atom.notifications.addInfo(message);
    }
  }
};
