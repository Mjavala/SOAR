import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { IDL } from "../../target/types/tens";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { SoarProgram, GameType, Genre, AccountsBuilder } from "../sdk/lib";
import BN from "bn.js";
import * as utils from "./utils";

describe("tens", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const tensProgramId = new PublicKey(
    "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
  );
  const tensProgram = new Program(IDL, tensProgramId, provider);

  const soar = SoarProgram.get(provider);

  const gameKp = Keypair.generate();
  // The SOAR state for our tens program.
  const soarGame = gameKp.publicKey;

  // The `offChainAuthority` is an authority of the SOAR state representing our `tens` game that
  // exists off-chain. The SOAR state can also have an on-chain PDA of the `tens` program, giving
  // it both a permissioned(signed by a real-user), and permissionless(signed by an on-chain PDA)
  // authority.
  //
  // Either OR both authority kinds can exist for a SOAR state. Here we use the `offChainAuthority`
  // so we can keep admin actions that don't rely on our `tens` program's on-chain logic off-chain.
  // (i.e like updating a game and leaderboard).
  //
  // For admin actions that we want to be permissionless(i.e in this case we want our `tens` game to
  // automatically submit a score for a user), we can set a `tens` PDA as an additional authority and
  // write CPI functionality to call and sign the submitScore instruction from our on-chain program.
  let offChainAuthority = Keypair.generate();
  let auths = [offChainAuthority.publicKey];

  const user = Keypair.generate();

  it("Can play the tens game and submit scores directly on-chain by CPI!", async () => {
    let title = "Tens";
    let description = "Increase and get a ten to win!";
    let genre = Genre.Casual;
    let gameType = GameType.Web;
    let nftMeta = Keypair.generate().publicKey;

    // Initialize the `SOAR` state representing the `tens` game.
    let { transaction: init } = await soar.initializeNewGame(
      gameKp.publicKey,
      title,
      description,
      genre,
      gameType,
      nftMeta,
      auths
    );
    await soar.sendAndConfirmTransaction(init, [gameKp]);

    let leaderboardDescription = "LeaderBoard1";
    let leaderboardMeta = Keypair.generate().publicKey;

    // Initialize a leaderboard for it.
    let { newLeaderBoard, topEntries, transaction } =
      await soar.addNewGameLeaderBoard(
        soarGame,
        offChainAuthority.publicKey,
        leaderboardDescription,
        leaderboardMeta,
        5,
        false
      );
    await soar.sendAndConfirmTransaction(transaction, [offChainAuthority]);

    // Derive the tensStatePDA of the `tens` program.
    let tensPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("tens")],
      tensProgram.programId
    )[0];
    // Initialize the internal state and register its `SOAR` game and leaderboard in our tens program
    // so it can validate that the correct accounts are passed in for subsequent instructions.
    await tensProgram.methods
      .register(soarGame, newLeaderBoard, topEntries)
      .accounts({
        signer: provider.publicKey,
        tensState: tensPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([])
      .rpc();

    // Make the tensState PDA of our `tens` program an authority of the game so it can permissionlessly
    // sign CPI requests to SOAR that require the authority's signature.
    let newAuths = auths.concat([tensPDA]);
    auths = newAuths;

    let { transaction: update } = await soar.updateGameAccount(
      soarGame,
      offChainAuthority.publicKey,
      undefined,
      newAuths
    );
    await soar.sendAndConfirmTransaction(update, [offChainAuthority]);

    // Initialize a SOAR player account, required for interacting with the `tens` game.
    let { transaction: initPlayer } = await soar.initializePlayerAccount(
      user.publicKey,
      "player1",
      PublicKey.default
    );
    await soar.sendAndConfirmTransaction(initPlayer, [user]);

    // Register the player to the leaderboard.
    let { newList: playerScoresList, transaction: regPlayer } =
      await soar.registerPlayerEntryForLeaderBoard(
        user.publicKey,
        newLeaderBoard
      );
    await soar.sendAndConfirmTransaction(regPlayer, [user]);
    console.log(`Registered to leaderboard ${newLeaderBoard.toBase58()}!\n`);

    // Repetitively make moves in the tens game. Scores will be submitted automatically by CPI.
    for (let i = 0; i < 20; ++i) {
      // Use the helper function from the SOAR sdk to get the accounts required for a submit score CPI.
      // This conveniently derive accounts required for CPI.
      //
      // The authority for this submitScore instruction is the tensState PDA of the `tens` program.
      //
      // Since this has been made an authority for the SOAR state, it is now authorized to sign
      // for the submitScore instruction and will do so by CPI.
      //
      const accounts = await new AccountsBuilder(
        provider,
        soar.program.programId
      ).submitScoreAccounts(user.publicKey, tensPDA, newLeaderBoard);

      await tensProgram.methods
        .makeMove()
        .accounts({
          user: user.publicKey,
          tensState: tensPDA,
          soarState: accounts.game, // `soarGame` can also be used here.
          soarLeaderboard: accounts.leaderboard,
          soarPlayerAccount: accounts.playerAccount,
          soarPlayerScores: accounts.playerScores,
          soarTopEntries: accounts.topEntries, // created when player registered to leaderboard
          soarProgram: soar.program.programId,
          systemProgram: accounts.systemProgram,
        })
        .signers([user])
        .rpc();

      let tens = await tensProgram.account.tens.fetch(tensPDA);
      let counter = tens.counter.toNumber();

      if (counter % 10 !== 0) {
        console.log(`..Moved ${counter}. Keep going!`);
      } else {
        console.log(`> Brilliant!. You moved ${counter} and won this round!`);
        let playerScores = await soar.fetchPlayerScoresListAccount(
          accounts.playerScores
        );
        console.log(
          `> Added ${counter} to your scores: ${JSON.stringify(
            playerScores.pretty().scores
          )}\n`
        );
      }
    }

    //---------------------------------------------------------------------------------------------//
    //                       Setup mint and token accounts for testing.                            //
    //---------------------------------------------------------------------------------------------//
    let { mint, authority } = await utils.initializeTestMint(soar);

    const tokenAccountOwner = offChainAuthority;
    const tokenAccount = await utils.createTokenAccount(
      soar,
      tokenAccountOwner.publicKey,
      mint
    );
    await utils.mintToAccount(soar, mint, authority, tokenAccount, 5);

    const userATA = await utils.createTokenAccount(soar, user.publicKey, mint);
    //---------------------------------------------------------------------------------------------//
    //---------------------------------------------------------------------------------------------//

    // Now we add an achievement for this game and a ft reward for that achievement.
    const { newAchievement, transaction: addAchievement } =
      await soar.addNewGameAchievement(
        soarGame,
        offChainAuthority.publicKey,
        "title",
        "desc",
        PublicKey.default
      );
    await soar.sendAndConfirmTransaction(addAchievement, [offChainAuthority]);

    const reward = Keypair.generate();
    const { newReward, transaction: addReward } = await soar.addFungibleReward(
      offChainAuthority.publicKey,
      reward.publicKey,
      newAchievement,
      new BN(4),
      new BN(5),
      new BN(100),
      mint,
      tokenAccount,
      tokenAccountOwner.publicKey
    );
    await soar.sendAndConfirmTransaction(addReward, [
      reward,
      tokenAccountOwner,
    ]);

    // Now the user can try to claim a reward by sending a transaction to the `tens` smart-contract.
    //
    // The `tens` smart-contract decides what invariant it wants to establish for a reward to be
    // claimed for a user. In this particular case, our on-chain program chooses to only claim rewards
    // for users that have a score in the `top-entries` list for our leaderboard. Since this is handled
    // on-chain, our on-chain authority(the tens PDA) is used.
    ///
    const accounts = await new AccountsBuilder(
      provider,
      soar.program.programId
    ).claimFtRewardAccounts(
      tensPDA,
      newAchievement,
      user.publicKey,
      newReward,
      soarGame
    );
    await utils.airdropTo(soar, user.publicKey, 1);

    let balance = await soar.provider.connection.getTokenAccountBalance(
      userATA
    );
    console.log(`> Balance before claim: ${balance.value.uiAmount}`);

    console.log("..claiming...");
    await tensProgram.methods
      .claimReward()
      .accounts({
        user: user.publicKey,
        tensState: tensPDA,
        playerAccount: accounts.playerAccount,
        soarPlayerScores: playerScoresList,
        soarTopEntries: topEntries,
        soarState: accounts.game,
        soarAchievement: accounts.achievement,
        soarReward: accounts.reward,
        soarPlayerAchievement: accounts.playerAchievement,
        sourceTokenAccount: accounts.sourceTokenAccount,
        userTokenAccount: accounts.userTokenAccount,
        tokenProgram: accounts.tokenProgram,
        systemProgram: SystemProgram.programId,
        soarProgram: soar.program.programId,
      })
      .signers([user])
      .rpc();

    balance = await soar.provider.connection.getTokenAccountBalance(userATA);
    console.log(`> Claim successful. New balance: ${balance.value.uiAmount}`);
  });
});
