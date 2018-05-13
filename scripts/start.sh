SCRIPTPATH="$(dirname "$(readlink -f "$0")")"
PROJECTPATH="$(dirname $SCRIPTPATH)"


# Install
pushd $PROJECTPATH
yarn
popd


# Build
$PROJECTPATH/node_modules/.bin/babel -d $PROJECTPATH/build $PROJECTPATH/src


# Run
node $PROJECTPATH/build $1
