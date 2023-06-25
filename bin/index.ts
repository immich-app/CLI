#! /usr/bin/env node
import axios, { AxiosRequestConfig } from 'axios';
import { program, Option } from 'commander';
import * as fs from 'fs';
import { fdir, PathsOutput } from 'fdir';
import * as si from 'systeminformation';
import * as readline from 'readline';
import * as path from 'path';
import FormData from 'form-data';
import * as cliProgress from 'cli-progress';
import { stat } from 'fs/promises';
// GLOBAL
import * as mime from 'mime-types';
import chalk from 'chalk';
import pjson from '../package.json';
import pLimit from 'p-limit';

const log = console.log;
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
let errorAssets: any[] = [];

const SUPPORTED_MIME = [
  // IMAGES
  'image/heif',
  'image/heic',
  'image/jpeg',
  'image/png',
  'image/jpg',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/dng',
  'image/x-adobe-dng',
  'image/webp',
  'image/tiff',
  'image/nef',
  'image/x-nikon-nef',

  // VIDEO
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/3gpp',
];

program.name('immich').description('Immich command line interface').version(pjson.version);

program
  .command('upload')
  .description('Upload assets to an Immich instance')
  .usage('upload [options] <paths...>')
  .addOption(new Option('-k, --key <value>', 'API Key').env('IMMICH_API_KEY'))
  .addOption(
    new Option(
      '-s, --server <value>',
      'Immich server address (http://<your-ip>:2283/api or https://<your-domain>/api)',
    ).env('IMMICH_SERVER_ADDRESS'),
  )
  .addOption(new Option('-r, --recursive', 'Recursive').env('IMMICH_RECURSIVE').default(false))
  .addOption(new Option('-y, --yes', 'Assume yes on all interactive prompts').env('IMMICH_ASSUME_YES'))
  .addOption(new Option('-da, --delete', 'Delete local assets after upload').env('IMMICH_DELETE_ASSETS'))
  .addOption(
    new Option('-t, --threads <num>', 'Amount of concurrent upload threads (default=5)').env('IMMICH_UPLOAD_THREADS'),
  )
  .addOption(
    new Option('-al, --album [album]', 'Create albums for assets based on the parent folder or a given name').env(
      'IMMICH_CREATE_ALBUMS',
    ),
  )
  .addOption(
    new Option('-i, --import', 'Import instead of upload').env(
      'IMMICH_IMPORT',
    ).default(false)
  )
  .addOption(new Option('-id, --device-uuid <value>', 'Set a device UUID').env('IMMICH_DEVICE_UUID'))
  .addOption(
    new Option(
      '-d, --directory <value>',
      'Upload assets recursively from the specified directory (DEPRECATED, use path argument with --recursive instead)',
    ).env('IMMICH_TARGET_DIRECTORY'),
  )
  .addOption(
    new Option(
      '-i, --ignore <value>', 
      'Ignore files matching regexp',
    ).env('IMMICH_IGNORE_REGEXP')
  )
  .argument('[paths...]', 'One or more paths to assets to be uploaded')
  .action((paths, options) => {
    if (options.directory) {
      if (paths.length > 0) {
        log(chalk.red("Error: Can't use deprecated --directory option when specifying paths"));
        process.exit(1);
      }
      if (options.recursive) {
        log(chalk.red("Error: Can't use deprecated --directory option together with --recursive"));
        process.exit(1);
      }
      log(
        chalk.yellow(
          'Warning: deprecated option --directory used, this will be removed in a future release. Please specify paths with --recursive instead',
        ),
      );
      paths.push(options.directory);
      options.recursive = true;
    } else {
      if (paths.length === 0) {
        // If no path argument is given, check if an env variable is set
        const envPath = process.env.IMMICH_ASSET_PATH;
        if (!envPath) {
          log(chalk.red('Error: Must specify at least one path'));
          process.exit(1);
        } else {
          paths = [envPath];
        }
      }
    }
    if (options.ignore) {
      options.ignore=options.ignore.split(',')
      //log(`Ignore: ${options.ignore[1]}`)
    }
    //else {
    //  log(`No Ignore oprion given`)
    //}

    upload(paths, options);
  });

program.parse(process.argv);

async function upload(
  paths: string[],
  {
    key,
    server,
    recursive,
    yes: assumeYes,
    delete: deleteAssets,
    uploadThreads,
    album: createAlbums,
    deviceUuid: deviceUuid,
    import: doImport,
    ignore,
  }: any,
) {
  const endpoint = server;
  const deviceId = deviceUuid || (await si.uuid()).os || 'CLI';
  const osInfo = (await si.osInfo()).distro;
  const localAssets: any[] = [];

  // Ping server
  log('Checking connectivity with Immich instance...');
  await pingServer(endpoint);

  // Login
  log('Checking credentials...');
  const user = await validateConnection(endpoint, key);
  log(chalk.green(`Successful authentication for user ${user.email}`));

  // Index provided directory
  log('Indexing local assets...');

  let crawler = new fdir().withFullPaths();

  if (!recursive) {
    // Don't go into subfolders
    crawler = crawler.withMaxDepth(0);
  }

  const files: any[] = [];

  for (const newPath of paths) {
    try {
      // Check if the path can be accessed
      fs.accessSync(newPath);
    } catch (e) {
      log(chalk.red(e));
      process.exit(1);
    }

    const stats = fs.lstatSync(newPath);

    if (stats.isDirectory()) {
      // Path is a directory so use the crawler to crawl it (potentially very large list)
      const children = crawler.crawl(newPath).sync() as PathsOutput;
      for (const child of children) {
        files.push(child);
      }
    } else {
      // Path is a single file
      files.push(path.resolve(newPath));
    }
  }

  // Ensure that list of files only has unique entries
  const uniqueFiles = new Set(files);

  for (const filePath of uniqueFiles) {

    //log(`Iterating over ${filePath} ${path.basename(filePath)}`)
    //var debug=filePath.match("@eaDir")
    //log(`Iterating over2 ${debug}`)

    var doIgnore=false
    for (const regexp of ignore) {
      if (filePath.match(regexp)) {
        //log(`MATCH: ${regexp} in ${filePath}`)
        doIgnore=true
        break
      }
      //else {
      //  log(`NOmatch: ${regexp} in ${filePath}`)
      //}
    }

    if (!doIgnore) {
      const mimeType = mime.lookup(filePath) as string;
      if (SUPPORTED_MIME.includes(mimeType)) {
        try {
          const fileStat = fs.statSync(filePath);
          localAssets.push({
            id: `${path.basename(filePath)}-${fileStat.size}`.replace(/\s+/g, ''),
            filePath,
          });
        } catch (e) {
          errorAssets.push({
            file: filePath,
            reason: e,
            response: e.response?.data,
          });
          continue;
        }
      }
    }
  }
  if (localAssets.length == 0) {
    log('No local assets found, exiting');
    process.exit(0);
  }

  log(`Indexing complete, found ${localAssets.length} local assets`);

  log('Comparing local assets with those on the Immich instance...');

  const backupAsset = await getAssetInfoFromServer(endpoint, key, deviceId);

  const newAssets = localAssets.filter((a) => !backupAsset.includes(a.id));
  if (localAssets.length == 0 || (newAssets.length == 0 && !createAlbums)) {
    log(chalk.green('All assets have been backed up to the server'));
    process.exit(0);
  } else {
    log(chalk.green(`A total of ${newAssets.length} assets will be uploaded to the server`));
  }

  if (createAlbums) {
    log(
      chalk.green(
        `A total of ${localAssets.length} assets will be added to album(s).\n` +
          'NOTE: some assets may already be associated with the album, this will not create duplicates.',
      ),
    );
  }

  // Ask user
  try {
    //There is a promise API for readline, but it's currently experimental
    //https://nodejs.org/api/readline.html#promises-api
    const answer = assumeYes
      ? 'y'
      : await new Promise((resolve) => {
          rl.question('Do you want to start upload now? (y/n) ', resolve);
        });
    const deleteLocalAsset = deleteAssets ? 'y' : 'n';

    if (answer == 'n') {
      log(chalk.yellow('Abort Upload Process'));
      process.exit(1);
    }

    if (answer == 'y') {
      log(chalk.green('Start uploading...'));
      const progressBar = new cliProgress.SingleBar(
        {
          format: 'Upload Progress | {bar} | {percentage}% || {value}/{total} || Current file [{filepath}]',
        },
        cliProgress.Presets.shades_classic,
      );
      progressBar.start(localAssets.length, 0, { filepath: '' });

      const assetDirectoryMap: Map<string, string[]> = new Map();

      const uploadQueue = [];

      const limit = pLimit(uploadThreads ?? 5);

      for (const asset of localAssets) {
        const album = asset.filePath.split(path.sep).slice(-2)[0];
        if (!assetDirectoryMap.has(album)) {
          assetDirectoryMap.set(album, []);
        }

        if (!backupAsset.includes(asset.id)) {
          // New file, lets upload it!
          uploadQueue.push(
            limit(async () => {
              try {
                const res = await startUpload(endpoint, key, asset, deviceId, doImport);
                progressBar.increment(1, { filepath: asset.filePath });
                if (res && (res.status == 201 || res.status == 200)) {
                  if (deleteLocalAsset == 'y') {
                    fs.unlink(asset.filePath, (err) => {
                      if (err) {
                        log(err);
                        return;
                      }
                    });
                  }
                  backupAsset.push(asset.id);
                  assetDirectoryMap.get(album)!.push(res!.data.id);
                }
              } catch (err) {
                log(chalk.red(err.message));
              }
            }),
          );
        } else if (createAlbums) {
          // Existing file. No need to upload it BUT lets still add to Album.
          uploadQueue.push(
            limit(async () => {
              try {
                // Fetch existing asset from server
                const res = await axios.post(
                  `${endpoint}/asset/check`,
                  {
                    deviceAssetId: asset.id,
                    deviceId,
                  },
                  {
                    headers: { 'x-api-key': key },
                  },
                );
                assetDirectoryMap.get(album)!.push(res!.data.id);
              } catch (err) {
                log(chalk.red(err.message));
              }
            }),
          );
        }
      }

      const uploads = await Promise.all(uploadQueue);

      progressBar.stop();

      if (createAlbums) {
        log(chalk.green('Creating albums...'));

        const serverAlbums = await getAlbumsFromServer(endpoint, key);

        if (typeof createAlbums === 'boolean') {
          progressBar.start(assetDirectoryMap.size, 0);

          for (const localAlbum of assetDirectoryMap.keys()) {
            const serverAlbumIndex = serverAlbums.findIndex((album: any) => album.albumName === localAlbum);
            let albumId: string;
            if (serverAlbumIndex > -1) {
              albumId = serverAlbums[serverAlbumIndex].id;
            } else {
              albumId = await createAlbum(endpoint, key, localAlbum);
            }

            if (albumId) {
              await addAssetsToAlbum(endpoint, key, albumId, assetDirectoryMap.get(localAlbum)!);
            }

            progressBar.increment();
          }

          progressBar.stop();
        } else {
          const serverAlbumIndex = serverAlbums.findIndex((album: any) => album.albumName === createAlbums);
          let albumId: string;

          if (serverAlbumIndex > -1) {
            albumId = serverAlbums[serverAlbumIndex].id;
          } else {
            albumId = await createAlbum(endpoint, key, createAlbums);
          }

          await addAssetsToAlbum(endpoint, key, albumId, Array.from(assetDirectoryMap.values()).flat());
        }
      }

      // log(chalk.yellow(`Failed to upload ${errorAssets.length} files `), errorAssets);

      for (const error of errorAssets) {
        console.log("Error asset: ", error)
      }

      if (errorAssets.length > 0) {
        process.exit(1);
      }

      process.exit(0);
    }
  } catch (e) {
    log(chalk.red('Error reading input from user '), e);
    process.exit(1);
  }
}

async function startUpload(endpoint: string, key: string, asset: any, deviceId: string, doImport: boolean) {
  try {
    const assetType = getAssetType(asset.filePath);
    const fileStat = await stat(asset.filePath);

    const data: any = {
      deviceAssetId: asset.id,
      deviceId,
      assetType,
      fileCreatedAt: fileStat.mtime.toISOString(),
      fileModifiedAt: fileStat.mtime.toISOString(),
      isFavorite: String(false),
      fileExtension: path.extname(asset.filePath),
      duration: '0:00:00.000000',
      isReadOnly: doImport ? String(true) : String(false),
    }

    const formData = new FormData()
    if (!doImport) {
      for (const prop in data) {
        formData.append(prop, data[prop])
      }

      formData.append("assetData", fs.createReadStream(asset.filePath));
    } else {
      data.assetPath = asset.filePath;
    }

    try {
      await fs.promises.access(`${asset.filePath}.xmp`, fs.constants.W_OK);
      if (doImport) {
        data.sidecarPath = path.resolve(`${asset.filePath}.xmp`)
      } else {
        formData.append("sidecarData", fs.createReadStream(path.resolve(`${asset.filePath}.xmp`)), { contentType: 'application/xml' });
      }
    } catch (e) {}

    const config: AxiosRequestConfig<any> = {
      method: 'post',
      maxRedirects: 0,
      url: doImport == true ? `${endpoint}/asset/import` : `${endpoint}/asset/upload`,
      headers: {
        'x-api-key': key,
        ...(doImport == false && formData.getHeaders()),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      data: doImport ? data : formData,
    };

    const res = await axios(config);
    return res;
  } catch (e) {
    errorAssets.push({
      file: asset.filePath,
      reason: e,
      response: e.response?.data,
    });
    return null;
  }
}

async function getAlbumsFromServer(endpoint: string, key: string) {
  try {
    const res = await axios.get(`${endpoint}/album`, {
      headers: { 'x-api-key': key },
    });
    return res.data;
  } catch (e) {
    log(chalk.red('Error getting albums'), e);
    process.exit(1);
  }
}

async function createAlbum(endpoint: string, key: string, albumName: string) {
  try {
    const res = await axios.post(
      `${endpoint}/album`,
      { albumName },
      {
        headers: { 'x-api-key': key },
      },
    );
    return res.data.id;
  } catch (e) {
    log(chalk.red(`Error creating album '${albumName}'`), e);
  }
}

async function addAssetsToAlbum(endpoint: string, key: string, albumId: string, assetIds: string[]) {
  try {
    await axios.put(
      `${endpoint}/album/${albumId}/assets`,
      { assetIds: [...new Set(assetIds)] },
      {
        headers: { 'x-api-key': key },
      },
    );
  } catch (e) {
    log(chalk.red('Error adding asset to album'), e);
  }
}

async function getAssetInfoFromServer(endpoint: string, key: string, deviceId: string) {
  try {
    const res = await axios.get(`${endpoint}/asset/${deviceId}`, {
      headers: { 'x-api-key': key },
    });
    return res.data;
  } catch (e) {
    log(chalk.red("Error getting device's uploaded assets"));
    process.exit(1);
  }
}

async function pingServer(endpoint: string) {
  try {
    const res = await axios.get(`${endpoint}/server-info/ping`);
    if (res.data['res'] == 'pong') {
      log(chalk.green('Server status: OK'));
    }
  } catch (e) {
    log(chalk.red('Error connecting to server - check server address and port'));
    process.exit(1);
  }
}

async function validateConnection(endpoint: string, key: string) {
  try {
    const res = await axios.get(`${endpoint}/user/me`, {
      headers: { 'x-api-key': key },
    });

    if (res.status == 200) {
      log(chalk.green('Login status: OK'));
      return res.data;
    }
  } catch (e) {
    log(chalk.red('Error logging in - check api key'));
    process.exit(1);
  }
}

function getAssetType(filePath: string) {
  const mimeType = mime.lookup(filePath) as string;

  return mimeType.split('/')[0].toUpperCase();
}
