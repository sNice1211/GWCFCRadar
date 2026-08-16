/* eslint-disable import/no-extraneous-dependencies */
import gulp from 'gulp';
import jsdoc2md from 'jsdoc-to-markdown';
import jsdoc from 'gulp-jsdoc3';
import fs from 'fs';
import { deleteAsync } from 'del';

const files = [
	'src/index.js',
	'src/parsedata.js',
	'src/typedefs.js',
	'src/classes/RandomAccessFile.js',
	'src/classes/Level2Record.js',
	'README.md',
];

const mdConfig = {
	files,
	'global-index-format': 'grouped',
};

const htmlConfig = {
	opts: {
		destination: './docs',
	},

};

gulp.task('docs', async () => {
	await deleteAsync(['API.md', 'docs/']);
	await jsdoc2md.render(mdConfig).then((output) => fs.writeFileSync('API.md', output));
	return gulp.src(files, { read: false })
		.pipe(jsdoc(htmlConfig));
});
